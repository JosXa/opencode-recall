import { Model, type Plugin, Provider } from '@opencode/plugin'
import type { Plugin as NativePlugin } from '@opencode/plugin/effect'
import { Session } from '@opencode/schema/session'
import { type Context, Effect } from 'effect'

type NativeGeneration = {
  text: NativePlugin.Context['generate']['text']
  session: NativePlugin.Context['session']['generate']
}

/** Stop superseded model calls upstream instead of only discarding their UI results. */
export function autocompleteGeneration(
  native: NativeGeneration,
  runtime: Context.Context<unknown>,
): {
  text: Plugin.Context['generate']['text']
  session: Plugin.Context['session']['generate']
} {
  const run = Effect.runPromiseWith(runtime)
  const text: Plugin.Context['generate']['text'] = async (input, options) => {
    // Effect starts its fiber before attaching the signal, so reject an already aborted call first.
    options?.signal?.throwIfAborted()
    return run(
      native.text({
        prompt: input.prompt,
        model: input.model
          ? Model.Ref.make({
              ...input.model,
              providerID: Provider.ID.make(input.model.providerID),
              id: Model.ID.make(input.model.id),
              variant: input.model.variant ? Model.VariantID.make(input.model.variant) : undefined,
            })
          : undefined,
      }),
      { signal: options?.signal },
    )
  }
  const session: Plugin.Context['session']['generate'] = async (input, options) => {
    options?.signal?.throwIfAborted()
    return run(native.session({ ...input, sessionID: Session.ID.make(input.sessionID) }), {
      signal: options?.signal,
    })
  }
  return { text, session }
}
