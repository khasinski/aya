type Agent = 'codex' | 'claude' | 'pi' | 'antigravity';
export type GuiPermissionMode = 'supervised' | 'auto-accept-edits' | 'auto' | 'full-access';
export interface GuiPermissionModeOption { id: GuiPermissionMode; label: string; description: string }

export function guiPermissionModes(agent: Agent): GuiPermissionModeOption[];
export function guiPermissionModeLabel(mode: GuiPermissionMode): string;
export function parseGuiPermissionMode(raw: unknown): GuiPermissionMode | undefined;
export function initialGuiPermissionMode(agent: Agent, unsafe: boolean): GuiPermissionMode;
export function nextGuiPermissionMode(agent: Agent, current: GuiPermissionMode): GuiPermissionMode;
export function claudePermissionMode(mode: GuiPermissionMode): 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions';
export function fromClaudePermissionMode(raw: unknown): GuiPermissionMode | undefined;
export function codexPermissionPolicy(mode: GuiPermissionMode): {
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  approvalsReviewer: 'user' | 'auto_review';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  sandboxPolicy: { type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' };
};
export function approvalNoteDelivery(agent: Agent): 'reason' | 'follow-up' | 'none';
export function claudeDeclineMessage(note: unknown): string;
