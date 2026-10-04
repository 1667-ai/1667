import { useEffect, useRef } from "react";

/** One message of a request document: the next request's, or a historical one. */
export interface DocMessage {
  readonly key: string;
  readonly role: string;
  /** What the message is (for example "facts" or "source part-3"). */
  readonly label: string;
  /** The right-hand figure, such as a token count. */
  readonly figure?: string;
  /** Lines of metadata above the text (an image block). */
  readonly extra?: readonly string[];
  readonly content: string;
}

/** A labelled block of notices above the messages. */
export interface DocSection {
  readonly label: string;
  readonly lines: readonly string[];
}

/**
 * The request document (#409 step 10g): notices, then the messages in the
 * order the provider receives them. The next-request viewer and the record
 * viewer both render it. One message is selected; ↑↓ move it (the pages own
 * the keys) and a click selects it.
 */
export function RequestDocument(
  { label, sections, messages, selected, onSelect, empty }: {
    /** Names the message list, such as "Next request messages". */
    readonly label: string;
    readonly sections: readonly DocSection[];
    readonly messages: readonly DocMessage[];
    readonly selected: number;
    readonly onSelect: (index: number) => void;
    readonly empty: string;
  }
) {
  const selectedRef = useRef<HTMLLIElement>(null);
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: "nearest" }); }, [selected, messages]);

  return (
    <div className="request-doc">
      {sections.map((section) => (
        <section key={section.label} className="request-notes" aria-label={section.label}>
          <h2 className="request-notes-label">{section.label}</h2>
          <ul>
            {section.lines.map((line, index) => <li key={index}>{line}</li>)}
          </ul>
        </section>
      ))}
      {messages.length === 0
        ? <p className="request-empty">{empty}</p>
        : (
          <ol className="request-messages" aria-label={label}>
            {messages.map((message, index) => (
              <li
                key={message.key}
                ref={index === selected ? selectedRef : undefined}
                className={`request-message${index === selected ? " selected" : ""}`}
                aria-current={index === selected ? "true" : undefined}
                data-role={message.role}
                onClick={() => onSelect(index)}
              >
                <header className="request-message-head">
                  <span className="request-message-number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="request-message-role">{message.role}</span>
                  <span className="request-message-label">{message.label}</span>
                  {message.figure !== undefined && <span className="request-message-figure">{message.figure}</span>}
                </header>
                {message.extra?.map((line, extraIndex) => <p key={extraIndex} className="request-message-extra">{line}</p>)}
                <pre className="request-message-body">{message.content}</pre>
              </li>
            ))}
          </ol>
        )}
    </div>
  );
}
