import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

// Which rows ease in (`.row-enter` in index.css): only those that join a scope after it was first
// drawn. A thread drawn from its history, or a fold opened onto its rows, shows them as they are; a
// step, a thought or the agent's words arriving while it is read eases in where it lands (ADR 0118).

const EnterContext = createContext<{ readonly current: boolean }>({ current: false });

/** Rows inside are new to the reader once this scope has been drawn once. */
export function EnterScope({ children }: { children: ReactNode }) {
  const drawn = useRef(false);
  useEffect(() => { drawn.current = true; }, []);
  return <EnterContext.Provider value={drawn}>{children}</EnterContext.Provider>;
}

/** The class a row mounts with: `row-enter` when it joined after its scope was drawn, decided once. */
export function useEnter(): string | undefined {
  const drawn = useContext(EnterContext);
  const [enter] = useState(() => (drawn.current ? "row-enter" : undefined));
  return enter;
}
