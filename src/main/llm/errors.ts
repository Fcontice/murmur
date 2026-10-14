/**
 * The model stopped because it reached max_tokens, so its text is incomplete. Callers must not
 * use it in place of the user's text: pasting it over a selection would lose the rest.
 */
export class TruncatedError extends Error {
  constructor(readonly partial: string) {
    super('The language model reply was cut off at its length limit')
    this.name = 'TruncatedError'
  }
}
