import type { ClientProps, ElementConstructor, JsonValue, RenderElement } from 'claude-code'

// Every Client tag of hairline. At load the engine reads each tag's module path off the source,
// and it parses in full every file that names the tag or holds JSX: register.tsx cost about 40 ms
// of startup that way, this file a few. So register.tsx draws with h() and calls these.
// Each function returns null on a surface without Client modules: only the terminal and the
// desktop app run them.

type Tag = ElementConstructor<ClientProps>
const tagIn = (elements: object): Tag | null => ('Client' in elements ? (elements as { Client: Tag }).Client : null)

export const hasRegions = (elements: object): boolean => tagIn(elements) !== null

export function spinnerRegion(elements: object, props: JsonValue): RenderElement | null {
  const Client = tagIn(elements)
  return Client && <Client key="hairline-spinner" module="./spinner.tsx" props={props} />
}

export function slotRegion(elements: object, props: JsonValue): RenderElement | null {
  const Client = tagIn(elements)
  return Client && <Client key="hairline-slot" module="./slot.tsx" props={props} />
}

export function speedRegion(elements: object, props: JsonValue): RenderElement | null {
  const Client = tagIn(elements)
  return Client && <Client key="hairline-speed" module="./speed.tsx" props={props} />
}

export function chipRegion(elements: object, key: string, props: JsonValue): RenderElement | null {
  const Client = tagIn(elements)
  return Client && <Client key={key} module="./chip.tsx" props={props} />
}
