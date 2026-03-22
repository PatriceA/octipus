import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { skills } from '@/db/schema/skills';
import { logger } from '@/utils/logger';
import type { NewSkill } from '@/db/schema/skills';

const SYSTEM_SKILLS: Omit<NewSkill, 'isSystem' | 'userId' | 'createdAt' | 'updatedAt'>[] = [
  { id: 'software-architecture', name: 'Software Architecture', category: 'engineering', description: 'Clean architecture, domain-driven design, and structural patterns for maintainable systems.', principles: ['Separate concerns into distinct layers (presentation, domain, infrastructure)', 'Depend on abstractions, not concretions (Dependency Inversion)', 'Single Responsibility — each module has one reason to change', 'Open/Closed — extend behavior without modifying existing code', 'Bounded contexts encapsulate domain logic and language'], bestPractices: ['Use hexagonal/ports-and-adapters to isolate business logic from I/O', 'Define explicit module boundaries with public APIs and internal implementations', 'Apply CQRS when read/write patterns diverge significantly', 'Document architecture decisions with lightweight ADRs', 'Prefer composition over inheritance for flexible behavior'], antiPatterns: ['Big Ball of Mud — no discernible structure or boundaries', 'God class/module that handles too many responsibilities', 'Circular dependencies between layers or modules', 'Premature abstraction — adding layers before complexity warrants them'], frameworks: ['Clean Architecture', 'DDD', 'Hexagonal Architecture', 'SOLID', 'C4 Model'] },
  { id: 'data-structures', name: 'Data Structures & Algorithms', category: 'engineering', description: 'Choosing and applying the right data structures and algorithms for efficient solutions.', principles: ['Choose data structures based on access patterns (read-heavy vs write-heavy)', 'Understand time/space complexity tradeoffs for every operation', 'Prefer hash maps for O(1) lookups, trees for ordered data', 'Use graphs when relationships between entities matter', 'Amortized analysis reveals true cost of dynamic structures'], bestPractices: ['Profile before optimizing — measure actual bottlenecks', 'Use built-in standard library implementations over custom ones', 'Consider cache locality — arrays beat linked lists for iteration', 'Pick the simplest structure that meets performance requirements', 'Use priority queues for scheduling and top-K problems'], antiPatterns: ['Using linked lists when arrays suffice (poor cache performance)', 'Nested loops when a hash set would eliminate O(n) lookups', 'Premature optimization without profiling evidence', 'Ignoring worst-case complexity in latency-sensitive paths'], frameworks: ['Big-O Analysis', 'Amortized Analysis', 'Bloom Filters', 'B-Trees', 'Skip Lists'] },
  { id: 'test-automation', name: 'Test Automation', category: 'engineering', description: 'Test-driven development, test pyramid strategies, and reliable automated testing.', principles: ['Follow the test pyramid: many unit tests, fewer integration, fewest E2E', 'Tests should be fast, isolated, repeatable, and self-validating', 'Write the test first (TDD) to drive design and catch regressions early', 'Test behavior, not implementation details', 'Each test should have a single clear reason to fail'], bestPractices: ['Use BDD-style descriptions (given/when/then) for readability', 'Mock external dependencies at boundaries, not internal modules', 'Maintain a fast CI feedback loop — under 10 minutes for unit tests', 'Use property-based testing for edge-case discovery', 'Track coverage trends, not absolute thresholds'], antiPatterns: ['Ice-cream cone — too many slow E2E tests, too few unit tests', 'Flaky tests that pass/fail non-deterministically', 'Testing private methods instead of public contracts', 'Copy-paste test setup instead of shared fixtures'], frameworks: ['TDD', 'BDD', 'Test Pyramid', 'Property-Based Testing', 'Mutation Testing'] },
  { id: 'design-principles', name: 'Design Principles', category: 'design', description: 'UI/UX fundamentals, accessibility, responsive design, and user-centered thinking.', principles: ['Design for the user, not the developer — empathy first', 'Maintain visual hierarchy through size, color, and spacing', 'Accessibility is not optional — WCAG AA minimum', 'Consistency reduces cognitive load across the interface', 'Progressive disclosure — show only what is needed at each step'], bestPractices: ['Mobile-first responsive design with fluid layouts', 'Use semantic HTML and ARIA labels for screen readers', 'Maintain 4.5:1 minimum contrast ratio for text', 'Design with real content, not Lorem Ipsum', 'Validate designs with usability testing early and often'], antiPatterns: ['Dark patterns that trick users into unintended actions', 'Ignoring keyboard navigation and focus management', 'Overloading screens with options (Hick\'s Law)', 'Designing for pixel-perfect at one breakpoint only'], frameworks: ['WCAG 2.1', 'Material Design', 'Human Interface Guidelines', 'Gestalt Principles', 'Nielsen Heuristics'] },
  { id: 'design-frameworks', name: 'Design Frameworks', category: 'design', description: 'Design systems, component libraries, and structured approaches to scalable UI design.', principles: ['Design tokens encode decisions (color, spacing, type) as reusable variables', 'Atomic design: atoms > molecules > organisms > templates > pages', 'Components should be composable, themeable, and self-documenting', 'Single source of truth — design and code stay in sync'], bestPractices: ['Build a shared component library with versioned releases', 'Document components with live examples and usage guidelines', 'Use Figma auto-layout and variants to mirror code components', 'Enforce design tokens in CSS/JS to prevent one-off values', 'Review design system adoption metrics regularly'], antiPatterns: ['Snowflake components that duplicate existing patterns', 'Design system as afterthought — built after product ships', 'No governance — anyone adds components without review', 'Over-engineering components before validating real use cases'], frameworks: ['Atomic Design', 'Storybook', 'Figma Dev Mode', 'Design Tokens (W3C)', 'Tailwind/Radix'] },
  { id: 'devops-practices', name: 'DevOps Practices', category: 'operations', description: 'CI/CD pipelines, infrastructure as code, GitOps, monitoring, and site reliability.', principles: ['Automate everything repeatable — builds, tests, deployments, rollbacks', 'Infrastructure as Code — version-controlled, reviewable, reproducible', 'Shift left on security and testing — catch issues early in the pipeline', 'Observability triad: metrics, logs, traces', 'Blameless postmortems drive continuous improvement'], bestPractices: ['Trunk-based development with short-lived feature branches', 'Blue-green or canary deployments for zero-downtime releases', 'Define SLIs/SLOs and alert on error budgets, not thresholds', 'Use GitOps — Git as single source of truth for desired state', 'Immutable infrastructure — replace, never patch in place'], antiPatterns: ['Manual deployments with undocumented steps', 'Snowflake servers configured by hand', 'Alert fatigue from noisy, non-actionable notifications', 'Long-lived feature branches causing merge conflicts'], frameworks: ['GitOps', 'SRE', 'DORA Metrics', 'Terraform', 'ArgoCD'] },
  { id: 'container-orchestration', name: 'Container Orchestration', category: 'operations', description: 'Docker, Kubernetes, Helm charts, service mesh, and container lifecycle management.', principles: ['One process per container — single responsibility', 'Containers are ephemeral — store state externally', 'Declarative desired state over imperative commands', 'Resource limits prevent noisy-neighbor problems', 'Health checks (liveness/readiness) enable self-healing'], bestPractices: ['Multi-stage builds for minimal production images', 'Use namespaces and RBAC for workload isolation', 'Helm charts or Kustomize for templated, reusable manifests', 'Set CPU/memory requests and limits on every pod', 'Use service mesh (Istio/Linkerd) for mTLS and traffic control'], antiPatterns: ['Running containers as root without security contexts', 'Fat images with build tools included in production', 'Hardcoded config instead of ConfigMaps/Secrets', 'No resource limits leading to OOM kills and instability'], frameworks: ['Docker', 'Kubernetes', 'Helm', 'Istio', 'Kustomize'] },
  { id: 'security-practices', name: 'Security Practices', category: 'engineering', description: 'Application security, threat modeling, zero trust architecture, and compliance.', principles: ['Zero Trust — never trust, always verify, least privilege', 'Defense in depth — multiple layers of security controls', 'Secure by default — safe configuration out of the box', 'Assume breach — design for detection and containment', 'Shift left — integrate security testing into CI/CD'], bestPractices: ['Validate and sanitize all input at trust boundaries', 'Use parameterized queries to prevent SQL injection', 'Rotate secrets regularly, store in vaults (not code)', 'Run SAST/DAST scans in CI pipelines', 'Conduct threat modeling (STRIDE) for new features'], antiPatterns: ['Security through obscurity as primary defense', 'Hardcoded secrets or API keys in source code', 'Overly permissive CORS or IAM policies', 'Ignoring dependency vulnerabilities (unpatched CVEs)', 'Logging sensitive data (PII, tokens, passwords)'], frameworks: ['OWASP Top 10', 'STRIDE', 'Zero Trust', 'NIST CSF', 'CIS Benchmarks'] },
  { id: 'cloud-platforms', name: 'Cloud Platforms', category: 'operations', description: 'AWS, GCP, Azure patterns, serverless architectures, and well-architected principles.', principles: ['Design for failure — assume any component can fail at any time', 'Use managed services to reduce operational burden', 'Multi-AZ/region for high availability and disaster recovery', 'Pay for what you use — right-size and auto-scale', 'Shared responsibility model — know what you own vs the provider'], bestPractices: ['Use serverless (Lambda/Cloud Functions) for event-driven workloads', 'Tag all resources for cost allocation and governance', 'Enable VPC flow logs and CloudTrail for audit trails', 'Use CDN (CloudFront/Cloud CDN) for static asset delivery', 'Implement landing zones and account-per-workload isolation'], antiPatterns: ['Lift-and-shift without re-architecting for cloud patterns', 'Single-AZ deployments for production workloads', 'Over-provisioning instead of auto-scaling', 'Vendor lock-in without abstraction layers where it matters'], frameworks: ['AWS Well-Architected', 'GCP Architecture Framework', 'FinOps', 'Serverless Framework', 'Pulumi'] },
  { id: 'financial-analysis', name: 'Financial Analysis', category: 'business', description: 'Market analysis, portfolio theory, risk management, and investment strategies.', principles: ['Diversification reduces unsystematic risk across asset classes', 'Risk and return are correlated — higher return demands higher risk', 'Time in the market beats timing the market for long-term investors', 'Compound interest is the most powerful force in wealth building', 'Past performance does not guarantee future results'], bestPractices: ['Use low-cost index ETFs as core portfolio holdings', 'Rebalance periodically to maintain target asset allocation', 'Analyze P/E, P/B, and free cash flow for equity valuation', 'Stress-test portfolios against historical drawdown scenarios', 'Account for fees, taxes, and inflation in return calculations'], antiPatterns: ['Chasing recent winners (recency bias)', 'Concentrated positions without understanding tail risk', 'Ignoring expense ratios and transaction costs', 'Emotional trading during market volatility'], frameworks: ['Modern Portfolio Theory', 'CAPM', 'DCF Analysis', 'Sharpe Ratio', 'Monte Carlo Simulation'] },
  { id: 'ai-engineering', name: 'AI Engineering', category: 'science', description: 'LLM applications, prompt engineering, RAG pipelines, fine-tuning, and agent architectures.', principles: ['Garbage in, garbage out — data quality drives model quality', 'Use RAG before fine-tuning — retrieval is cheaper and more flexible', 'Evaluate with task-specific metrics, not just perplexity', 'Agents need guardrails — constrain tool use and output validation', 'Prompt engineering is iterative — version and test systematically'], bestPractices: ['Chunk documents with overlap for effective vector retrieval', 'Use structured output (JSON mode) for reliable downstream parsing', 'Implement fallback chains: primary model > fallback > cached response', 'Log all LLM calls with inputs/outputs for debugging and evaluation', 'Use few-shot examples to steer model behavior consistently'], antiPatterns: ['Fine-tuning when prompt engineering or RAG would suffice', 'No evaluation harness — shipping prompts without regression tests', 'Unbounded agent loops without max iterations or cost limits', 'Ignoring token costs and latency in production architectures'], frameworks: ['RAG', 'ReAct Agents', 'LangChain/LlamaIndex', 'DSPy', 'LMQL'] },
  { id: 'automation-patterns', name: 'Automation Patterns', category: 'operations', description: 'Workflow engines, event-driven automation, orchestration vs choreography.', principles: ['Automate the toil — repetitive, tactical, no lasting value work', 'Idempotency — running the same automation twice yields the same result', 'Orchestration for complex flows, choreography for loose coupling', 'Event-driven triggers over polling for responsiveness and efficiency', 'Every automated process needs a manual override escape hatch'], bestPractices: ['Use workflow engines (Temporal/N8N) for multi-step processes with retries', 'Implement dead-letter queues for failed event processing', 'Version workflows — support in-flight migrations', 'Log every step with correlation IDs for end-to-end tracing', 'Start with manual + script before building full automation'], antiPatterns: ['Automating a broken process instead of fixing it first', 'Silent failures — no alerting when automation stops working', 'Tight coupling between workflow steps via shared mutable state', 'Over-engineering simple cron jobs into complex orchestration'], frameworks: ['BPMN', 'Temporal', 'N8N', 'Apache Airflow', 'Event-Driven Architecture'] },
  { id: 'database-design', name: 'Database Design', category: 'engineering', description: 'Relational, NoSQL, and graph databases — schema design, indexing, and selection criteria.', principles: ['Choose the database based on query patterns, not hype', 'Normalize for write integrity, denormalize for read performance', 'Indexes speed reads but slow writes — index deliberately', 'ACID for correctness-critical data, eventual consistency where tolerable', 'Schema design is driven by access patterns, not entity relationships alone'], bestPractices: ['Use EXPLAIN/ANALYZE to understand and optimize query plans', 'Add composite indexes matching your most frequent WHERE clauses', 'Use connection pooling to manage database connections efficiently', 'Partition large tables by time or tenant for manageability', 'Use migrations for all schema changes — never manual DDL in production'], antiPatterns: ['EAV (Entity-Attribute-Value) when a proper schema would work', 'Missing indexes on foreign keys and frequent filter columns', 'Storing JSON blobs in SQL when you query inside them constantly', 'N+1 queries — fetching related records one at a time in loops'], frameworks: ['PostgreSQL', 'Redis', 'MongoDB', 'Neo4j', 'Drizzle/Prisma ORM'] },
  { id: 'api-design', name: 'API Design', category: 'engineering', description: 'REST, GraphQL, gRPC best practices — versioning, pagination, error handling.', principles: ['APIs are contracts — breaking changes need explicit versioning', 'Use nouns for resources, HTTP verbs for actions (REST)', 'Be consistent in naming, casing, and response structure', 'Design for the consumer, not the internal data model', 'Idempotent operations (PUT, DELETE) simplify retries'], bestPractices: ['Use cursor-based pagination for large, changing datasets', 'Return structured errors with code, message, and details', 'Version via URL path (/v1/) or Accept header', 'Document with OpenAPI/Swagger and generate client SDKs', 'Use rate limiting and request validation at the gateway'], antiPatterns: ['Chatty APIs requiring many round-trips for one task', 'Exposing internal database IDs or schema directly', 'Inconsistent error formats across endpoints', 'Breaking changes in minor versions without deprecation'], frameworks: ['REST', 'GraphQL', 'gRPC', 'OpenAPI 3.x', 'JSON:API'] },
  { id: 'project-management', name: 'Project Management', category: 'business', description: 'Agile methodologies, estimation, prioritization, and delivery risk management.', principles: ['Deliver working increments early and often for fast feedback', 'Prioritize ruthlessly — focus on highest value, lowest effort first', 'Estimates are ranges, not commitments — communicate uncertainty', 'Limit work in progress to maximize throughput', 'Retrospectives drive continuous process improvement'], bestPractices: ['Use story points for relative sizing, not hours', 'Keep sprints short (1-2 weeks) for faster course correction', 'Visualize work with Kanban boards and track cycle time', 'Identify and mitigate risks weekly — maintain a risk register', 'Define clear Definition of Done before starting work'], antiPatterns: ['Scope creep without re-negotiating timelines', 'Estimation by decree instead of team consensus', 'Zombie projects — no one cancels failing initiatives', 'Cargo-cult Agile — ceremonies without understanding the values'], frameworks: ['Scrum', 'Kanban', 'SAFe', 'Shape Up', 'RICE Prioritization'] },
  { id: 'technical-writing', name: 'Technical Writing', category: 'engineering', description: 'Documentation, architecture decision records, runbooks, and API documentation.', principles: ['Write for the reader — match their skill level and context', 'Conciseness over completeness — remove what does not help', 'Structure content with headings, lists, and progressive detail', 'Keep docs close to code — co-locate and version together', 'Docs are a product — maintain, review, and deprecate them'], bestPractices: ['Use ADRs (Architecture Decision Records) for significant choices', 'Write runbooks with exact commands and expected outputs', 'Auto-generate API docs from OpenAPI specs', 'Include diagrams (Mermaid/PlantUML) for architecture and flows', 'Review docs in PRs alongside code changes'], antiPatterns: ['Write-once docs that rot and mislead', 'Wiki sprawl — no ownership, no structure, no search', 'Documenting how instead of why for design decisions', 'Tribal knowledge locked in Slack threads and meetings'], frameworks: ['Diátaxis', 'ADR', 'OpenAPI', 'Mermaid', 'Docs-as-Code'] },
  { id: 'performance-engineering', name: 'Performance Engineering', category: 'engineering', description: 'Profiling, caching strategies, optimization techniques, and benchmarking.', principles: ['Measure first — never optimize without profiling data', 'Optimize the bottleneck — Amdahl\'s Law limits parallel gains', 'Caching trades freshness for speed — define acceptable staleness', 'Latency budgets distribute acceptable delay across components', 'Performance is a feature — set and enforce SLOs'], bestPractices: ['Use flame graphs and CPU/memory profilers to find hot paths', 'Cache at multiple layers: CDN, reverse proxy, application, database', 'Benchmark with realistic data volumes and concurrency levels', 'Lazy-load resources and defer non-critical work', 'Set P50, P95, P99 latency targets for key endpoints'], antiPatterns: ['Premature optimization without measurement', 'Cache-everything approach leading to stale data bugs', 'Load testing only in dev with unrealistic data sizes', 'Ignoring tail latency (P99) while optimizing averages'], frameworks: ['Flame Graphs', 'K6/Locust', 'Core Web Vitals', 'Redis Caching', 'CDN Edge Caching'] },
  { id: 'data-engineering', name: 'Data Engineering', category: 'engineering', description: 'ETL/ELT pipelines, data warehousing, streaming, and data quality practices.', principles: ['ELT over ETL — load raw data first, transform in the warehouse', 'Idempotent pipelines — safe to re-run without duplicating data', 'Schema evolution must be backward-compatible', 'Data quality is enforced at ingestion, not after analysis', 'Partition and cluster data by common query dimensions'], bestPractices: ['Use medallion architecture: bronze (raw), silver (cleaned), gold (aggregated)', 'Implement data contracts between producers and consumers', 'Add data quality checks (nulls, ranges, freshness) in pipelines', 'Use streaming (Kafka/Kinesis) for real-time, batch for historical', 'Track data lineage for debugging and compliance'], antiPatterns: ['Monolithic pipelines that are impossible to debug or restart partially', 'No schema validation — garbage data propagates silently', 'Tightly coupling dashboards to raw source tables', 'Manual CSV uploads as a permanent data integration strategy'], frameworks: ['dbt', 'Apache Kafka', 'Apache Spark', 'Medallion Architecture', 'Great Expectations'] },
  { id: 'machine-learning', name: 'Machine Learning', category: 'science', description: 'ML algorithms, feature engineering, model evaluation, and deployment patterns.', principles: ['No free lunch — no single algorithm is best for all problems', 'More data often beats a better algorithm', 'Bias-variance tradeoff governs model generalization', 'Feature engineering is where domain knowledge creates value', 'Validate on held-out data that mirrors production distribution'], bestPractices: ['Start with a simple baseline (logistic regression, decision tree)', 'Use cross-validation to get robust performance estimates', 'Track experiments with versioned data, code, and hyperparameters', 'Monitor model drift in production with statistical tests', 'Use SHAP/LIME for model interpretability and stakeholder trust'], antiPatterns: ['Training on test data (data leakage)', 'Using accuracy as sole metric for imbalanced datasets', 'Skipping exploratory data analysis before modeling', 'Deploying models without monitoring for feature/concept drift'], frameworks: ['Scikit-learn', 'XGBoost', 'MLflow', 'SHAP', 'Weights & Biases'] },
  { id: 'plugin-development', name: 'Plugin Development', category: 'engineering', description: 'Building plugins for the Assistant platform — manifest format, tool definitions, entry file structure, and deployment.', content: `You are an expert at building plugins for the Assistant platform. When a user asks you to create a plugin, you build it correctly using the filesystem tool and place it in the extensions/ directory.

## Plugin Structure

Every plugin is a directory inside \`extensions/\` containing exactly two files:

\`\`\`
extensions/
  <plugin-name>/
    plugin.json    # Manifest (required)
    index.ts       # Entry file (required)
\`\`\`

## plugin.json Manifest

\`\`\`json
{
  "name": "<plugin-name>",
  "version": "1.0.0",
  "description": "<what the plugin does>",
  "author": "<author>",
  "main": "index.ts",
  "tools": [
    {
      "name": "<tool_name>",
      "description": "<what this tool does>",
      "parameters": {
        "<param_name>": {
          "type": "string|number|boolean",
          "description": "<param description>",
          "required": true
        }
      }
    }
  ]
}
\`\`\`

Rules:
- "name" must be lowercase, alphanumeric with hyphens only
- Each tool in "tools" array must have a unique name
- Parameter types: "string", "number", "boolean"
- Set "required": true for mandatory parameters
- Use "default" for optional parameters with defaults

## index.ts Entry File

\`\`\`typescript
import type { PluginContext } from '../../src/plugins/types';

export default {
  name: '<plugin-name>',

  async initialize(context: PluginContext): Promise<void> {
    context.logger.info('<Plugin Name> initialized');
  },

  tools: {
    async <tool_name>(args: Record<string, unknown>): Promise<unknown> {
      // Implement the tool logic here
      // Access parameters: args.<param_name> as <type>
      // Return a JSON-serializable result object
      return { result: 'success' };
    },
  },

  async shutdown(): Promise<void> {
    // Optional cleanup
  },
};
\`\`\`

Rules:
- The default export must have "name" matching the manifest
- Every tool listed in plugin.json must have a corresponding function in "tools"
- Tool functions receive args as Record<string, unknown> — cast to expected types
- Tool functions must return a JSON-serializable value
- Use try/catch and return { error: 'message' } for error cases
- The import path for PluginContext is always '../../src/plugins/types'

## Building a Plugin Step by Step

1. Create the plugin directory: \`extensions/<plugin-name>/\`
2. Write plugin.json with the manifest
3. Write index.ts with tool implementations
4. The plugin is automatically loaded on next backend restart
5. Alternatively, call POST /api/plugins/<plugin-name>/reload to hot-reload

## Best Practices

- Keep plugins focused — one plugin per concern
- Validate all inputs at the start of each tool function
- Return descriptive error messages
- Use the logger from PluginContext for debugging
- For HTTP calls, use fetch() (available in Bun runtime)
- For file operations, use Bun.file() or Node fs module
- Keep tool names short and descriptive using snake_case
- Write clear tool descriptions — agents read these to decide when to use the tool

## Common Plugin Patterns

### HTTP API Integration
\`\`\`typescript
async fetch_data(args: Record<string, unknown>): Promise<unknown> {
  const url = args.url as string;
  try {
    const response = await fetch(url);
    if (!response.ok) return { error: \\\`HTTP \\\${response.status}\\\` };
    return await response.json();
  } catch (err: any) {
    return { error: err.message };
  }
}
\`\`\`

### File Processing
\`\`\`typescript
async process_file(args: Record<string, unknown>): Promise<unknown> {
  const path = args.path as string;
  const file = Bun.file(path);
  if (!await file.exists()) return { error: 'File not found' };
  const content = await file.text();
  // Process content...
  return { lines: content.split('\\n').length };
}
\`\`\`

### Command Execution
\`\`\`typescript
async run_command(args: Record<string, unknown>): Promise<unknown> {
  const cmd = args.command as string;
  const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}
\`\`\`

## After Creating the Plugin

Tell the user:
1. The plugin has been created at extensions/<plugin-name>/
2. Restart the backend or call the reload API to activate it
3. The new tools will appear under Tools in the web UI
4. Agents can use the tools immediately after loading`, principles: [], bestPractices: [], antiPatterns: [], frameworks: ['Bun Runtime', 'TypeScript', 'Plugin API'] },
  { id: 'networking', name: 'Networking', category: 'engineering', description: 'TCP/IP, DNS, load balancing, CDN, and network protocol fundamentals.', principles: ['End-to-end principle — keep intelligence at the edges, network simple', 'Layered protocols (OSI/TCP-IP) isolate concerns at each level', 'DNS is the first point of failure — low TTLs enable fast failover', 'TLS everywhere — encrypt all traffic in transit', 'Latency is distance divided by speed of light — physics matters'], bestPractices: ['Use L7 load balancers for path-based routing and health checks', 'Enable HTTP/2 or HTTP/3 for multiplexed, low-latency connections', 'Place CDN edges close to users for static and cacheable content', 'Implement connection timeouts and circuit breakers for resilience', 'Use private subnets and security groups for network segmentation'], antiPatterns: ['Single point of failure — no redundant DNS, LB, or links', 'Unbounded retry storms amplifying network failures', 'Exposing internal services directly to the public internet', 'Ignoring MTU and fragmentation in high-throughput paths'], frameworks: ['TCP/IP', 'HTTP/2-3', 'DNS', 'BGP', 'WireGuard/IPSec'] },
];

/**
 * Seed system skills into the database.
 * Idempotent — skips skills that already exist by id.
 */
export async function seedSkills(): Promise<void> {
  const db = getDb();

  for (const skill of SYSTEM_SKILLS) {
    const existing = await db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.id, skill.id))
      .limit(1);

    if (existing.length > 0) continue;

    await db.insert(skills).values({
      ...skill,
      isSystem: true,
      userId: null,
    });

    logger.info({ skill: skill.id }, 'Seeded skill');
  }
}
