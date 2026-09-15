import {
  digestText,
  type FirstTaskEvidence,
  type Row,
} from "./first-task-scoring.js";

const html = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export interface TranscriptEntry {
  id: string;
  kind: "comment" | "interaction" | "answer" | "document" | "run";
  at: string;
  checkpoint: string;
  row: Row;
}
/** Repeated API snapshots are observations, not additional chat messages. Keep
 * the latest comment/card state and every observed document revision. */
export function firstTaskTranscript(e: FirstTaskEvidence): TranscriptEntry[] {
  const entries = new Map<string, TranscriptEntry>();
  for (const checkpoint of e.checkpoints) {
    for (const [kind, rows] of [
      ["comment", checkpoint.comments],
      ["interaction", checkpoint.interactions],
      ["document", checkpoint.documents],
      ["run", checkpoint.runs],
    ] as const) {
      for (const row of rows) {
        const revision =
          kind === "document"
            ? `:${row.latestRevisionId ?? row.revisionId ?? digestText(String(row.body ?? ""))}`
            : "";
        const id = `${kind}:${row.issueId ?? ""}:${row.id ?? row.key}${revision}`;
        entries.set(id, {
          id,
          kind,
          at:
            kind === "run"
              ? (row.startedAt ??
                row.createdAt ??
                entries.get(id)?.at ??
                checkpoint.at)
              : kind === "document"
                ? (row.updatedAt ??
                  row.createdAt ??
                  entries.get(id)?.at ??
                  checkpoint.at)
                : (row.createdAt ?? entries.get(id)?.at ?? checkpoint.at),
          checkpoint: checkpoint.id,
          row,
        });
        if (kind === "interaction" && row.result && row.resolvedAt) {
          entries.set(`answer:${row.id}`, {
            id: `answer:${row.id}`,
            kind: "answer",
            at: row.resolvedAt,
            checkpoint: checkpoint.id,
            row,
          });
        }
      }
    }
  }
  return [...entries.values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );
}
const body = (value: unknown) =>
  `<div class="transcript-text">${html(value)}</div>`;
const raw = (value: unknown, title: string) =>
  `<details class="transcript-raw"><summary>${html(title)}</summary><pre>${html(JSON.stringify(value, null, 2))}</pre></details>`;
export function renderFirstTaskTranscript(
  e: FirstTaskEvidence,
  checkpointHref: (id: string) => string,
) {
  const names = new Map(
    e.checkpoints.flatMap((c) =>
      c.agents.map((a) => [a.id, a.name ?? a.id] as const),
    ),
  );
  const entries = firstTaskTranscript(e);
  return `<section class="transcript" aria-label="Recorded conversation">
    <p class="detail">Recorded conversation: comments, question and approval cards, answers, and observed document revisions. Repeated checkpoints are deduplicated. Run metadata is expandable; raw tool events are available through the evidence links. This is retained evidence, not a live task. Only messages and document revisions captured at checkpoints are available; messages from other tasks may not be included.</p>
    ${
      entries
        .map((entry) => {
          const row = entry.row;
          let title: string;
          let content: string;
          if (entry.kind === "comment") {
            title = row.authorAgentId
              ? `Agent · ${names.get(row.authorAgentId) ?? row.authorAgentId}`
              : "User";
            content = body(row.body);
          } else if (entry.kind === "interaction") {
            title = `${row.kind === "ask_user_questions" ? "Question card" : "Approval / interaction card"} · ${row.status}`;
            const questions =
              row.payload?.questionSet?.questions ??
              row.payload?.questions ??
              [];
            content =
              body(row.payload?.prompt ?? row.title ?? "") +
              questions
                .map(
                  (q: Row) =>
                    body(q.prompt) +
                    `<ul>${(q.options ?? []).map((o: Row) => `<li>${html(o.label)}${o.description ? ` — ${html(o.description)}` : ""}</li>`).join("")}</ul>`,
                )
                .join("") +
              (row.payload?.detailsMarkdown
                ? body(row.payload.detailsMarkdown)
                : "") +
              (row.payload?.options
                ? `<ul>${row.payload.options.map((o: Row) => `<li>${html(o.label)}</li>`).join("")}</ul>`
                : "") +
              (row.payload?.acceptLabel
                ? `<p>Accept: <strong>${html(row.payload.acceptLabel)}</strong> · Reject: ${html(row.payload.rejectLabel ?? "Decline")}</p>`
                : "") +
              raw(row, "Card payload and resolution");
          } else if (entry.kind === "answer") {
            title = row.resolvedByAgentId
              ? "Agent card response"
              : "User card response";
            const answers = row.result.answers ?? [];
            const questions =
              row.payload?.questionSet?.questions ??
              row.payload?.questions ??
              [];
            content = answers.length
              ? answers
                  .map((a: Row) => {
                    const question = questions.find(
                      (q: Row) => q.id === a.questionId,
                    );
                    const options = (a.optionIds ?? []).map(
                      (id: string) =>
                        question?.options?.find((o: Row) => o.id === id)
                          ?.label ?? id,
                    );
                    return (
                      body(question?.prompt ?? a.questionId) +
                      body(
                        [...options, a.otherText ?? a.text ?? ""]
                          .filter(Boolean)
                          .join("\n"),
                      )
                    );
                  })
                  .join("")
              : body(row.result.outcome ?? row.status) +
                (row.result.reason ? body(row.result.reason) : "");
            content += raw(row.result, "Recorded answer");
          } else if (entry.kind === "document") {
            title = `Document · ${row.title ?? row.key} · revision ${row.latestRevisionNumber ?? row.revisionNumber ?? "unreported"}`;
            content = body(row.body);
          } else {
            title = `Agent run · ${row.status}`;
            content = raw(row, `Run ${row.id} · metadata and usage`);
          }
          return `<article class="transcript-entry transcript-${entry.kind}"><header><strong>${html(title)}</strong><time>${html(entry.at)}</time></header>${content}<footer>${row.issueId ? `Task ${html(row.issueId)} · ` : ""}<a href="${html(checkpointHref(entry.checkpoint))}">Source checkpoint</a></footer></article>`;
        })
        .join("") || "<p>No conversation was recorded before the failure.</p>"
    }
  </section>`;
}
