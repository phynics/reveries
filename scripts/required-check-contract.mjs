/**
 * The single wording of the base-serialisation prerequisite, so the contract
 * file, the documentation, and the bot's own refusal cannot drift apart.
 *
 * The bot performs its checks, reads the pull request, and then calls the merge
 * endpoint. Between the last read and the merge, the base can advance. The merge
 * request's `sha` guards the head only. So a check-run binding — however
 * carefully constructed — is evidence about a moment that has already passed by
 * the time the merge lands.
 *
 * Closing that window is not something the bot can do for itself. It needs the
 * host to serialise: `strict_required_status_checks_policy` on the branch
 * ruleset makes GitHub refuse a merge whose branch is behind its base, so the
 * race is resolved by the platform. Until that setting is on, the bot refuses,
 * because a comparison it knows to be already stale is not evidence.
 */
export const STRICT_BASE_REQUIRED =
  "branch protection does not require branches to be up to date with the base "
  + "(strict_required_status_checks_policy), so a base that advances after this check would merge "
  + "against evidence that described the previous one. Enable strict required status checks on the "
  + "default-branch ruleset, or use a merge queue that serialises candidates, before relying on this bot.";
