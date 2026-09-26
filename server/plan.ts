/**
 * Plan mode: offering a plan for approval, and acting on the user's answer.
 */

import type { ProviderInput } from "@getpaseo/plugin/server/provider";
import { releaseDetached } from "./background";
import { IMPLEMENT_MODE_ID, IMPLEMENT_PLAN_TEXT } from "./constants";
import { configState } from "./settings";
import {
  type ConnectionState,
  type Emit,
  type PendingTurn,
  requireSession,
  type Session,
} from "./state";
import { applyPendingRestart, enqueuePrompt, startTurn } from "./turns";

/** The turn's last assistant text: what a plan-mode turn offers as its plan. */
export function lastAssistantText(turn: PendingTurn): string {
  let last = -1;
  for (const stepIndex of turn.assistant.keys()) last = Math.max(last, stepIndex);
  return last === -1 ? "" : (turn.assistant.get(last) ?? "");
}

/** Asks the user to implement the plan a plan-mode turn ended with. */
export function offerPlan(session: Session, emit: Emit, turn: PendingTurn, text: string): void {
  if (!session.planApproval || !turn.plan || text.trim().length === 0) return;
  resolvePendingPlan(session, emit);
  const id = `plan:${turn.turnId}`;
  session.pendingPlan = { id, text };
  emit({
    type: "session.permission",
    sessionId: session.sessionId,
    request: {
      id,
      name: "plan",
      kind: "plan",
      title: "Implement this plan?",
      detail: { type: "plan", text },
      actions: [
        { id: "implement", label: "Implement", behavior: "allow", variant: "primary", intent: "implement" },
        { id: "dismiss", label: "Keep planning", behavior: "deny", variant: "secondary", intent: "dismiss" },
      ],
    },
  });
}

/** Withdraws the plan prompt, if one is open. */
export function resolvePendingPlan(session: Session, emit: Emit): void {
  const plan = session.pendingPlan;
  if (!plan) return;
  session.pendingPlan = null;
  emit({ type: "session.permission_resolved", sessionId: session.sessionId, permissionId: plan.id });
}

/**
 * The user's answer to a plan prompt. Approving leaves plan mode for `accept-edits` — plan mode
 * would only have the model plan again — and sends the turn that implements the plan.
 */
export async function respondToPermission(
  input: Extract<ProviderInput, { type: "session.permission" }>,
  state: ConnectionState,
  emit: Emit,
): Promise<void> {
  const session = requireSession(state, input.sessionId);
  const plan = session.pendingPlan;
  if (!plan || plan.id !== input.permissionId) {
    console.error(`[antigravity] ignoring an answer to unknown permission ${input.permissionId}`);
    emit({ type: "session.permission_resolved", sessionId: session.sessionId, permissionId: input.permissionId });
    return;
  }
  resolvePendingPlan(session, emit);
  if (input.response.behavior !== "allow") return;

  session.selection.mode = IMPLEMENT_MODE_ID;
  emit({ type: "session.config", sessionId: session.sessionId, config: configState(session) });
  await enqueuePrompt(session, async () => {
    if (session.closing) return;
    // The mode is a launch flag, and the implementing turn is a plain message.
    session.launchPending = { schema: false, commands: false, skillDir: null };
    if (session.process?.running) session.needsRestart = true;
    await releaseDetached(session);
    await applyPendingRestart(session);
    await startTurn(session, emit, {
      shown: IMPLEMENT_PLAN_TEXT,
      text: IMPLEMENT_PLAN_TEXT,
      verbatim: false,
    });
  });
}
