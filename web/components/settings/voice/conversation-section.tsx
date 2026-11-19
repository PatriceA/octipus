'use client';

import { useState } from 'react';
import type { SettingItem } from '../setting-field';
import { type SettingSaver, settingValue, TextSetting, ToggleSetting } from './setting-controls';
import { quietBtn, Section } from './ui';

const SILENCE_KEY = 'voice.endpointSilenceMs';
const SILENCE_MIN = 300;
const SILENCE_MAX = 2000;

/** How a live voice conversation behaves: the language, when a turn ends, and interrupting. */
export function ConversationSection({ settings, saver }: { settings: SettingItem[]; saver: SettingSaver }) {
  const language = settingValue(settings, 'voice.language');
  const silence = settingValue(settings, SILENCE_KEY);
  const bargeIn = settingValue(settings, 'voice.bargeIn');
  const storedSilence = typeof silence === 'number' && Number.isFinite(silence) ? silence : 700;

  return (
    <Section title="Conversation" description="How a live voice conversation behaves, in the chat and in the mobile app." testId="voice-conversation">
      <div className="max-w-sm">
        <TextSetting
          settingKey="voice.language"
          label="Language"
          hint="A language code such as en or de, or auto to recognise it from what is said."
          value={typeof language === 'string' ? language : 'en'}
          placeholder="en"
          saver={saver}
        />
      </div>
      <SilenceSetting key={storedSilence} stored={storedSilence} saver={saver} />
      <ToggleSetting
        settingKey="voice.bargeIn"
        label="Talking over a reply stops it"
        hint="Off: the reply is always spoken to the end, and what you say meanwhile is ignored."
        checked={bargeIn !== false}
        saver={saver}
      />
    </Section>
  );
}

function SilenceSetting({ stored, saver }: { stored: number; saver: SettingSaver }) {
  const [draft, setDraft] = useState(stored);
  const dirty = draft !== stored;
  return (
    <div className="space-y-1 max-w-sm">
      <label htmlFor="voice-silence" className="block text-xs font-medium text-on-surface">
        A pause this long ends your turn: <span data-testid="silence-value">{(draft / 1000).toFixed(2)} s</span>
      </label>
      <div className="flex items-center gap-2">
        <input
          id="voice-silence"
          type="range"
          className="w-full accent-primary"
          min={SILENCE_MIN}
          max={Math.max(SILENCE_MAX, stored)}
          step={50}
          value={draft}
          onChange={(event) => setDraft(Number(event.target.value))}
        />
        <button type="button" className={quietBtn} disabled={!dirty || saver.saving === SILENCE_KEY} onClick={() => saver.save(SILENCE_KEY, draft)}>Save</button>
      </div>
      <p className="text-xs text-on-surface-variant">Longer if you are cut off in the middle of a sentence; shorter for quicker replies.</p>
    </div>
  );
}
