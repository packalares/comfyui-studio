import { _loadInternal, _saveInternal, type SettingsInternal } from './store.js';
import { env } from '../../config/env.js';
import {
  DEFAULT_CHAT_HIGH_WATER_PERCENT,
  DEFAULT_CHAT_MAX_TOOL_STEPS,
  DEFAULT_CHAT_LOADING_HINT_MS,
  DEFAULT_CHAT_KEEP_RECENT,
  DEFAULT_CHAT_TITLE_TIMEOUT_MS,
  DEFAULT_CHAT_SUMMARY_TIMEOUT_MS,
  DEFAULT_CHAT_SMART_SUGGESTIONS,
  DEFAULT_CHAT_DEFAULT_THINK_MODE,
  DEFAULT_DOWNLOADS_MAX_QUEUE,
} from './store.js';

function readPercent(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100 ? v : fallback;
}

function readPositiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function getChatHighWaterPercent(): number {
  return readPercent(_loadInternal().chatHighWaterPercent, DEFAULT_CHAT_HIGH_WATER_PERCENT);
}
export function getChatMaxToolSteps(): number {
  return readPositiveInt(_loadInternal().chatMaxToolSteps, DEFAULT_CHAT_MAX_TOOL_STEPS);
}
export function getChatLoadingHintMs(): number {
  return readPositiveInt(_loadInternal().chatLoadingHintMs, DEFAULT_CHAT_LOADING_HINT_MS);
}
export function getChatKeepRecent(): number {
  return readPositiveInt(_loadInternal().chatKeepRecent, DEFAULT_CHAT_KEEP_RECENT);
}
export function getChatTitleTimeoutMs(): number {
  return readPositiveInt(_loadInternal().chatTitleTimeoutMs, DEFAULT_CHAT_TITLE_TIMEOUT_MS);
}
export function getChatSummaryTimeoutMs(): number {
  return readPositiveInt(_loadInternal().chatSummaryTimeoutMs, DEFAULT_CHAT_SUMMARY_TIMEOUT_MS);
}
export function getChatSmartSuggestions(): boolean {
  const v = _loadInternal().chatSmartSuggestions;
  return typeof v === 'boolean' ? v : DEFAULT_CHAT_SMART_SUGGESTIONS;
}
export function getChatDefaultThinkMode(): 'on' | 'off' | 'auto' {
  const v = _loadInternal().chatDefaultThinkMode;
  return v === 'on' || v === 'off' || v === 'auto' ? v : DEFAULT_CHAT_DEFAULT_THINK_MODE;
}
// SECURITY: `studio_run_skill_script` only executes user scripts when this is true.
export function getChatEnableUserSkillScripts(): boolean {
  return _loadInternal().chatEnableUserSkillScripts === true;
}

function setNumeric(key: keyof SettingsInternal, value: number | null | undefined): void {
  const settings = _loadInternal();
  if (value == null || !Number.isFinite(value)) {
    const { [key]: _r, ...rest } = settings;
    _saveInternal(rest);
    return;
  }
  _saveInternal({ ...settings, [key]: value });
}

export function setChatHighWaterPercent(v: number | null | undefined): void {
  setNumeric('chatHighWaterPercent', v);
}
export function setChatMaxToolSteps(v: number | null | undefined): void {
  setNumeric('chatMaxToolSteps', v);
}
export function setChatLoadingHintMs(v: number | null | undefined): void {
  setNumeric('chatLoadingHintMs', v);
}
export function setChatKeepRecent(v: number | null | undefined): void {
  setNumeric('chatKeepRecent', v);
}
export function setChatTitleTimeoutMs(v: number | null | undefined): void {
  setNumeric('chatTitleTimeoutMs', v);
}
export function setChatSummaryTimeoutMs(v: number | null | undefined): void {
  setNumeric('chatSummaryTimeoutMs', v);
}
export function setChatSmartSuggestions(v: boolean | null | undefined): void {
  const settings = _loadInternal();
  if (v === null || v === undefined) {
    const { chatSmartSuggestions: _r, ...rest } = settings;
    _saveInternal(rest);
    return;
  }
  _saveInternal({ ...settings, chatSmartSuggestions: !!v });
}
export function setChatEnableUserSkillScripts(v: boolean | null | undefined): void {
  const settings = _loadInternal();
  if (v === null || v === undefined) {
    const { chatEnableUserSkillScripts: _r, ...rest } = settings;
    _saveInternal(rest);
    return;
  }
  _saveInternal({ ...settings, chatEnableUserSkillScripts: !!v });
}
export function setChatDefaultThinkMode(v: 'on' | 'off' | 'auto' | null | undefined): void {
  const settings = _loadInternal();
  if (v === null || v === undefined) {
    const { chatDefaultThinkMode: _r, ...rest } = settings;
    _saveInternal(rest);
    return;
  }
  if (v !== 'on' && v !== 'off' && v !== 'auto') return;
  _saveInternal({ ...settings, chatDefaultThinkMode: v });
}

// ─── Downloads backpressure ─────────────────────────────────────────────────

export function getDownloadsMaxQueue(): number {
  return readPositiveInt(_loadInternal().downloadsMaxQueue, DEFAULT_DOWNLOADS_MAX_QUEUE);
}
export function setDownloadsMaxQueue(v: number | null | undefined): void {
  setNumeric('downloadsMaxQueue', v);
}
export function getDownloadsMaxConcurrent(): number {
  // Falls back to env so an operator who hasn't opened Settings keeps the
  // env-driven default. Once the user persists a value, env is shadowed.
  return readPositiveInt(_loadInternal().downloadsMaxConcurrent, env.MAX_CONCURRENT_DOWNLOADS);
}
export function setDownloadsMaxConcurrent(v: number | null | undefined): void {
  setNumeric('downloadsMaxConcurrent', v);
}
