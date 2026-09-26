import { fetchPane, sendReply } from "./api";
import { sendGuardedReply as guarded, type GuardedReplyArgs as CoreArgs } from "./guarded-reply";
export { draftCarriesSend, MIN_MATCH_CHARS } from "./guarded-reply";
export type { ReplyOutcome, ComposerSeen, ComposerPrepResult } from "./guarded-reply";
export type GuardedReplyArgs = Omit<CoreArgs, "transport">;
export const sendGuardedReply = (args: GuardedReplyArgs) => guarded({ ...args, transport: { fetchPane, sendReply } });
