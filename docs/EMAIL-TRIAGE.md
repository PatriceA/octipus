# Email triage with a small decision model

Email triage gives every inbox mail a priority (`low`, `normal`, `high`) and a
category such as `work`, `promotion` or `notification`. A small local decision
model, such as Clef Flash on llama.cpp, can answer most mails cheaply and
privately. A general LLM, bound to the `everyday` lane, answers the rest.
Thresholds fitted from labelled mail decide which of the two answers each mail.
This page covers the setup, how the decision model is calibrated, and how to
check it is working.

## How a triage run works

`triageInbox` (`src/core/email/service.ts`) handles each batch of inbox mail in
this order:

1. **Owner labels win.** Mails you labelled yourself get your label back and
   no model is asked.
2. **The decision model answers every remaining mail.** It is asked three
   independent questions, described below, along with up to five worked
   examples from the training set.
3. **The gate.** A mail is decided when both the priority confidence and the
   category confidence reach your fitted thresholds. One confident answer is
   not enough: the whole mail goes to the LLM.
4. **The LLM answers the rest.** It also answers a 10% audit sample of the
   decided mails (`AUDIT_RATE`). The audit labels go into the training set and
   keep the thresholds honest. On an audited mail the decision model's answer
   still wins.
5. **Everything is recorded** in the training set (table
   `email_triage_labels`) and in the evaluation log.

The result is `{...llm, ...decided, ...owner}`: an owner label beats a
confident decision, which beats the LLM. If the LLM fails, a batch the decision
model answered completely is still returned. A batch with undecided mails fails
with the LLM's error.

## The questions

A small model is reliable on yes/no and pick-one questions and unreliable on
graded scales. On a single three-level priority scale Clef spread its
probability over neighbouring levels, with a median confidence of 0.41 against
0.79 for category. Priority is therefore asked as two yes/no questions:

| Question | Type | Meaning |
|---|---|---|
| `action` | yes/no | Does the recipient need to do something or reply? |
| `today` | yes/no | Does the email show that the recipient must act today? |
| `category` | choice | Which of the user's categories is this? |

They combine into one priority (`priorityFrom`):

- `action` is no → **low**, with the confidence of `action`.
- `action` is yes and `today` is yes → **high**.
- `action` is yes and `today` is no → **normal**.
- The confidence of high or normal is the lower of the two answers'
  confidences.

`today` needs evidence in the email: a deadline today or already passed, a
failed or due payment, a security problem, or someone who is blocked until the
recipient acts. An ordinary request to reply, review or decide is normal.
Rubric v3 asked only "act today?" and called 59 of 93 normal mails high.

The LLM gets the same rubric as three priority levels, so both models answer
the same question. Each question starts with a preamble saying that `examples`
are labelled mails from the same sender or domain, and that the owner's labels
(`labelledBy: owner`) outweigh model labels.

**Rubric version.** `PRIORITY_RUBRIC_VERSION` (currently `action-split-v4`) is
stored with every answer. Change it whenever you change a question or a
criterion. Calibration uses only answers from the current version. A model
label from an older version is dropped when the mail gets a new answer, so an
answer is never scored against a label for a different question. Owner labels
are kept across versions.

## Setup

1. **Register the decision model** as a `custom-openai` model row that speaks
   the SystemOne protocol (`metadata.decisionProtocol: 'systemone'`; see
   [plans/decision-models.md](plans/decision-models.md#approved-native-integration-2026-10-21)).
   Triage is a `personal` site: the mail never goes to a model that retains
   data. A local row needs an explicit data policy
   `{hosting: 'local', retention: 'none', trainsOnInput: false}`.
2. **Bind it to the `decision` lane** on the Topics page.
3. **Bind a reference LLM to the `everyday` lane.** It must be able to answer
   a single request. A CLI agent without a tool-less mode, such as `cli/codex`,
   cannot. In that case triage uses the lane's install backup and otherwise
   tells you what to bind. A personal model row (one you own) never falls back
   to the backup.
4. **Run the migrations.** Migration `0192_email_triage_labels` creates the
   training set and runs when the backend starts.

Without a model on the `decision` lane, triage is LLM-only, as it was before.

## Calibration

### The training set

`email_triage_labels` has one row per mail (user, provider, message id). Each
row holds:

- the sender, the subject and the first 300 characters of the snippet;
- the decision model's latest answer (`clef`): priority and category, the
  confidence of each, and the model and rubric version;
- the label it is measured against, with its source:
  - `user`: your own label. It is never overwritten.
  - `model`: a reference model's label. It is updated on every LLM answer for
    that mail and never replaces a `user` label.

### Fitting the thresholds

Each question gets its own threshold from the (confidence, correct) pairs of
current-rubric rows that have a label (`fitThreshold` in
`src/core/email/triage-labels.ts`):

- **Target:** answers at or above the threshold must be at least 90% correct
  (`TARGET_ACCURACY`).
- **Choice:** the lowest threshold that reaches the target with at least 10
  answers above it, so a few lucky answers cannot set it.
- **Fewer than 30 pairs** (`MIN_CALIBRATION`): the default of 0.7
  (`DEFAULT_THRESHOLD`).
- **No threshold reaches the target:** 1.01, so the decision model never
  decides that question and the LLM answers.

The thresholds are refitted at the start of every triage run, so new labels
take effect on the next run.

### Step 1: label a backlog with a reference model

You don't need to wait for weeks of triage to collect data. In **Email →
Review**:

1. Pick a model under **Label the inbox with**. It must be enabled and must not be a CLI
   agent. A strong, cheap API model such as DeepSeek works well.
2. Enter how many inbox mails to label (1–2000), e.g. 300, and click
   **Start**.

The run labels the mails in batches of 30 with that model. Then it runs the
decision model over the same mails, at the default threshold. The panel polls
the progress. A user can have one run at a time; a second start returns 409.
Progress is kept in memory, so a backend restart ends the run.

For 300 mails, labelling with DeepSeek cost a few cents. Clef took about 7 s
per mail (three questions), and up to 47 s when it was busy.

Run the backlog again after every rubric version change. That gives the new
version its 30 pairs right away.

### Step 2: review

The review queue shows the mails that have no owner label and where the
decision model and the label disagree, or where the gate would reject the
answer. Disagreements come first, then the least confident answers. For each
one, set the priority and category and confirm. That stores a `user` label,
which:

- is returned as-is for that mail from then on;
- counts in the threshold fit like any label, but is never replaced;
- is shown to the decision model first, as a worked example, for mails from
  the same sender or domain.

The panel shows how many labels come from you and how many from a model, and
for each question its fitted threshold, how many answers it lets through, and
their accuracy.

A note on the numbers: the queue picks the hard cases, so the accuracy on your
own labels alone looks worse than the accuracy on all mail.

### Worked examples

For each mail the decision model sees up to five labelled mails (`examplesFor`).
Mails from the same sender come first, then mails from the same domain. Owner
labels come before model labels, newest first, and the mail itself is never
included. The domain match is skipped for free-mail domains (gmail.com,
gmx.de, …), where the same domain says nothing about the sender.

## Checking it works

**In the panel.** Fitted thresholds around 0.75–0.85 with about 90% accuracy
mean the model is calibrated. A threshold of 1.01 means the question never
reaches 90%: change the question (and the rubric version) or use another
decision model.

**In the database.** This query shows accuracy and coverage for each candidate
threshold:

```sql
with t as (
  select clef->>'priority' cp, label_priority lp, (clef->>'priorityConfidence')::float pc,
         clef->>'category' cc, label_category lc, (clef->>'categoryConfidence')::float ccf
  from email_triage_labels
  where clef->>'rubric' = 'action-split-v4' and label_source is not null
), c(cut) as (select generate_series(0.5, 0.95, 0.05))
select cut,
  count(*) filter (where pc >= cut) prio_n,  round(avg((cp = lp)::int) filter (where pc >= cut), 2) prio_acc,
  count(*) filter (where ccf >= cut) cat_n,  round(avg((cc = lc)::int) filter (where ccf >= cut), 2) cat_acc
from c, t group by cut order by cut;
```

To see which priorities get confused, cross-tabulate `label_priority` against
`clef->>'priority'`. That is how v3's problem showed up: 59 mails labelled
normal had been answered high.

**In the evaluation log.** Every run appends `kind: "email-evaluation"` records
to `~/.octipus/decision-shadow.jsonl`. They carry the run id, the message id,
the thresholds, the decision model's answers with their confidences, and for
mails the LLM saw, its label and whether the two agreed. The `run_completed`
event counts `items`, `accepted` (decided) and `referenced` (sent to the LLM).
The log holds no sender, subject, snippet or body.

### Reference: rubric v3, 300 mails (2026-11-18)

These are the numbers that led to v4: 243 mails labelled by DeepSeek and 57 by
the owner.

| Threshold | Priority answers / accuracy | Category answers / accuracy |
|---|---|---|
| 0.70 | 220 / 85% | 215 / 87% |
| 0.75 | 200 / 93% | 192 / 92% |
| 0.85 | 174 / 98% | 145 / 97% |

The fitted thresholds came out at about 0.75. That let the decision model
answer about two thirds of all mail at 92–93% accuracy.

## Limits

- **The fit drifts conservative.** Only 10% of decided mails get a fresh label,
  so confident correct answers are under-represented below the current
  threshold, and the fitted threshold tends to creep upwards. If coverage
  stalls, run a backlog or review some mails.
- **Model labels are only as good as the reference model.** Your own labels
  are the only real ground truth, and they count the same in the fit as model
  labels do; they just never get replaced.
- **The gate is per mail, not per question.** A confident category with an
  unsure priority still sends the whole mail to the LLM.

## API

| Method and path | Purpose |
|---|---|
| `POST /api/email/triage` | Triage the inbox (the flow above). |
| `GET /api/email/triage/review` | The review queue, statistics, fitted thresholds and backlog progress. |
| `PUT /api/email/triage/label/:id` | Set your label `{priority, category}` for a mail triage has already seen; 404 otherwise. |
| `POST /api/email/triage/backlog` | `{model, limit}`: start a labelling run; 409 while one is running. |

## Files

- `src/core/email/service.ts`: questions, rubric, gate, triage run, backlog
  run.
- `src/core/email/triage-labels.ts`: training set, examples, threshold fit,
  review queue.
- `src/db/schema/email-triage-labels.ts`: table `email_triage_labels`.
- `web/components/mail/triage-review.tsx`: the Review panel.
- `src/models/decision.ts`: `decide()`, the privacy gate and the decision lane.
