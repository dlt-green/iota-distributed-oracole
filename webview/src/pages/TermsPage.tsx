// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { Fragment, useEffect, useMemo, useState } from "react";

type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "em"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; label: string; href: string };

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] };

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern = /(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^) \n]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push({ type: "text", value: text.slice(lastIndex, index) });
    }

    const token = match[0];
    if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const closeLabelIndex = token.indexOf("](");
      nodes.push({
        type: "link",
        label: token.slice(1, closeLabelIndex),
        href: token.slice(closeLabelIndex + 2, -1),
      });
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push({ type: "strong", value: token.slice(2, -2) });
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push({ type: "em", value: token.slice(1, -1) });
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push({ type: "text", value: text.slice(lastIndex) });
  }

  return nodes.length ? nodes : [{ type: "text", value: text }];
}

function renderInline(text: string) {
  return parseInline(text).map((node, index) => {
    if (node.type === "strong") {
      return <strong key={index}>{node.value}</strong>;
    }
    if (node.type === "em") {
      return <em key={index}>{node.value}</em>;
    }
    if (node.type === "code") {
      return <code key={index}>{node.value}</code>;
    }
    if (node.type === "link") {
      return (
        <a key={index} className="terms-inline-link" href={node.href} target="_blank" rel="noreferrer">
          {node.label}
        </a>
      );
    }
    return <Fragment key={index}>{node.value}</Fragment>;
  });
}

function parseMarkdown(markdown: string): Block[] {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (!line) {
      index += 1;
      continue;
    }

    if (line.startsWith("# ")) {
      blocks.push({ type: "heading", level: 1, text: line.slice(2).trim() });
      index += 1;
      continue;
    }

    if (line.startsWith("## ")) {
      blocks.push({ type: "heading", level: 2, text: line.slice(3).trim() });
      index += 1;
      continue;
    }

    if (line.startsWith("### ")) {
      blocks.push({ type: "heading", level: 3, text: line.slice(4).trim() });
      index += 1;
      continue;
    }

    if (/^- /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^- /.test(lines[index].trim())) {
        items.push(lines[index].trim().slice(2).trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next || next.startsWith("#") || /^- /.test(next) || /^\d+\.\s/.test(next)) {
        break;
      }
      paragraphLines.push(next);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

export default function TermsPage() {
  const [markdown, setMarkdown] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadTerms() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/legal/eula", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Unable to load EULA (${response.status})`);
        }
        const content = await response.text();
        if (!cancelled) {
          setMarkdown(content);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadTerms();
    return () => {
      cancelled = true;
    };
  }, []);

  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);

  return (
    <section className="card terms-page-card">
      <div className="terms-page-header">
        <div>
          <div className="eyebrow">Legal</div>
          <h2 className="terms-page-title">End User License Agreement</h2>
          <p className="terms-page-intro">
            This page loads the current legal text from the configured source and renders it in a readable format.
          </p>
        </div>
        <div className="terms-page-actions">
          <a className="terms-link-button" href="/api/legal/eula" target="_blank" rel="noreferrer">
            Open Markdown
          </a>
        </div>
      </div>

      {loading ? <div className="empty">Loading EULA…</div> : null}
      {error ? <div className="alert alert-error">{error}</div> : null}

      {!loading && !error ? (
        <article className="terms-document">
          {blocks.map((block, index) => {
            if (block.type === "heading") {
              if (block.level === 1) {
                return (
                  <h1 key={index} className="terms-h1">
                    {renderInline(block.text)}
                  </h1>
                );
              }
              if (block.level === 2) {
                return (
                  <h2 key={index} className="terms-h2">
                    {renderInline(block.text)}
                  </h2>
                );
              }
              return (
                <h3 key={index} className="terms-h3">
                  {renderInline(block.text)}
                </h3>
              );
            }

            if (block.type === "list") {
              const ListTag = block.ordered ? "ol" : "ul";
              return (
                <ListTag key={index} className={`terms-list ${block.ordered ? "is-ordered" : "is-unordered"}`}>
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{renderInline(item)}</li>
                  ))}
                </ListTag>
              );
            }

            return (
              <p key={index} className="terms-paragraph">
                {renderInline(block.text)}
              </p>
            );
          })}
        </article>
      ) : null}
    </section>
  );
}
