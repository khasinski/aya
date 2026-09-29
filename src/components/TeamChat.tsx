import { useLayoutEffect, useRef, useState } from "react";
import { teamChat, type ChatEntry } from "../team-chat";
import { messageDeliveryText, USER_SENDER } from "../team-view";
import type { TeamMessage } from "../types";

// Within this many px of the bottom, a new message scrolls into view.
const STICK_TO_BOTTOM_PX = 24;

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Alert({ message }: { message: TeamMessage }) {
  return <div className="aya-chat-alert">⚠ {messageDeliveryText(message)}</div>;
}

function Entry({ entry, pane }: { entry: ChatEntry; pane: (role: string) => string | null }) {
  const [open, setOpen] = useState(false);
  if (entry.kind === "delivery-test") {
    return (
      <div className="aya-chat-entry aya-chat-system">
        <button className="aya-chat-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {clock(entry.time)} Delivery test: {entry.answered.length}/{entry.tested.length} answered {open ? "▾" : "▸"}
        </button>
        {open &&
          entry.messages.map((m) => (
            <div key={m.id} className="aya-chat-sub">
              {clock(m.time)} {m.from} → {m.to}: {m.text}
            </div>
          ))}
      </div>
    );
  }
  const m = entry.message;
  if (entry.kind === "system") {
    return (
      <div className="aya-chat-entry aya-chat-system">
        <span>
          {clock(m.time)} {m.from === USER_SENDER ? "Your task" : "Aya"} to {m.to}:
        </span>{" "}
        <span className="aya-chat-system-text">{m.text}</span>
        {entry.abnormal && <Alert message={m} />}
      </div>
    );
  }
  const from = pane(m.from);
  return (
    <div className={`aya-chat-entry aya-chat-bubble${entry.abnormal ? " aya-chat-bubble--alert" : ""}`}>
      <div className="aya-chat-meta">
        <strong>{m.from}</strong>
        {from && <span className="aya-teams-muted">{from}</span>}
        <span className="aya-teams-muted">to {m.to}</span>
        <span className="aya-teams-spacer" />
        <span className="aya-teams-muted" title={`${m.commit ? `${m.commit} · ` : ""}${messageDeliveryText(m)}`}>
          {clock(m.time)}
        </span>
      </div>
      <div className="aya-chat-text">{m.text}</div>
      {entry.abnormal ? <Alert message={m} /> : <div className="aya-chat-foot">{[m.commit, "written"].filter(Boolean).join(" · ")}</div>}
    </div>
  );
}

/** The team log as a chat between the panes; `pane` names the pane playing a role. */
export function TeamChat({
  team,
  log,
  roles,
  pane,
}: {
  team: string;
  log: TeamMessage[];
  /** The team's role ids: a legacy role named "user" is a peer, not a task. */
  roles: string[];
  pane: (role: string) => string | null;
}) {
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const newest = log.at(-1)?.id;
  useLayoutEffect(() => {
    if (box.current && atBottom.current) box.current.scrollTop = box.current.scrollHeight;
  }, [newest, full]);
  return (
    <div className="aya-chat-wrap">
      <div className="aya-chat-head">
        <span className="aya-teams-muted">Messages · "written" means it reached the pane, not that it was read.</span>
        <span className="aya-teams-spacer" />
        <button className="aya-chat-toggle" onClick={() => setFull(!full)}>
          {full ? "Shorter" : "Full height"}
        </button>
      </div>
      <div
        ref={box}
        role="log"
        aria-label={`${team} messages`}
        className={`aya-chat${full ? " aya-chat--full" : ""}`}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
        }}
      >
        {teamChat(log, roles).map((entry) => (
          <Entry key={entry.kind === "delivery-test" ? `t${entry.id}` : entry.message.id} entry={entry} pane={pane} />
        ))}
      </div>
    </div>
  );
}
