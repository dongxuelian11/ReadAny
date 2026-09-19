// LEARN-01 — the help area of the teaching card: three asks (讲简单些 / 换个
// 例子 / 我卡在这里) and the bounded list of saved explanation rewrites. The
// original explanation and the pending check stay untouched above/below; a
// failed request is reported here and never clobbers the teaching content.

import { Button } from "@/components/ui/button";
import type { TeachingHelpKind, TeachingHelpVariant } from "@readany/core/learner";
import type { TFunction } from "i18next";
import { CircleAlert, LifeBuoy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const KIND_CHIP_CLASS: Record<TeachingHelpKind, string> = {
  simpler: "bg-primary/10 text-primary",
  example: "bg-primary/10 text-primary",
  stuck: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

/** Honest provenance for one response: full chapter, or the covered percent
 * range. Chapter-level granularity is stated as such — no fake precision. */
export function sourceCoverageLabel(
  source: TeachingHelpVariant["source"],
  t: TFunction,
): string | null {
  if (!source || source.total <= 0) return null;
  if (source.start === 0 && source.end >= source.total) {
    return t("learnerPanel.teaching.help.sourceFull");
  }
  const from = Math.min(99, Math.round((source.start / source.total) * 100));
  const to = Math.max(from + 1, Math.min(100, Math.round((source.end / source.total) * 100)));
  return t("learnerPanel.teaching.help.sourcePartial", { from, to });
}

export function TeachingHelpSection({
  variants,
  phase,
  error,
  disabled,
  onRequest,
  chapterIndex,
  onNavigateToChapter,
}: {
  variants: TeachingHelpVariant[];
  phase: "idle" | "loading" | "error";
  error: string | null;
  disabled: boolean;
  onRequest: (kind: TeachingHelpKind, note: string | null) => void;
  chapterIndex: number | null;
  onNavigateToChapter: (chapterIndex: number) => void;
}) {
  const { t } = useTranslation();
  const [stuckOpen, setStuckOpen] = useState(false);
  const [note, setNote] = useState("");

  const ask = (kind: TeachingHelpKind, stuckNote?: string) => {
    if (disabled || phase === "loading") return;
    if (kind === "stuck") {
      onRequest("stuck", stuckNote?.trim() ? stuckNote.trim() : null);
      setStuckOpen(false);
      setNote("");
      return;
    }
    onRequest(kind, null);
  };

  return (
    <div className="mt-3 border-t border-border/40 pt-3" data-testid="teaching-help">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <LifeBuoy className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        {t("learnerPanel.teaching.help.ask")}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs"
          disabled={disabled || phase === "loading"}
          onClick={() => ask("simpler")}
        >
          {t("learnerPanel.teaching.help.simpler")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs"
          disabled={disabled || phase === "loading"}
          onClick={() => ask("example")}
        >
          {t("learnerPanel.teaching.help.example")}
        </Button>
        <Button
          size="sm"
          variant={stuckOpen ? "secondary" : "outline"}
          className="h-7 px-2.5 text-xs"
          disabled={disabled || phase === "loading"}
          aria-expanded={stuckOpen}
          onClick={() => setStuckOpen((open) => !open)}
        >
          {t("learnerPanel.teaching.help.stuck")}
        </Button>
      </div>

      {stuckOpen && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") ask("stuck", note);
            }}
            placeholder={t("learnerPanel.teaching.help.stuckPlaceholder")}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button size="sm" className="h-8 shrink-0 text-xs" onClick={() => ask("stuck", note)}>
            {t("learnerPanel.teaching.help.stuckSend")}
          </Button>
        </div>
      )}

      <output className="mt-2 block text-xs" aria-live="polite">
        {phase === "loading" && (
          <p className="leading-5 text-muted-foreground">
            {t("learnerPanel.teaching.help.loading")}
          </p>
        )}
        {phase === "error" && (
          <p className="flex items-start gap-1.5 leading-5 text-destructive">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              {t("learnerPanel.teaching.help.failed")}
              {error ? (
                <span className="block break-words text-muted-foreground">{error}</span>
              ) : null}
            </span>
          </p>
        )}
      </output>

      {variants.length > 0 && (
        <ul className="mt-2 space-y-2">
          {variants.map((variant) => {
            const label = sourceCoverageLabel(variant.source, t);
            return (
              <li key={variant.id} className="rounded-md border border-border/60 bg-muted/30 p-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${KIND_CHIP_CLASS[variant.kind]}`}
                  >
                    {t(`learnerPanel.teaching.help.kind.${variant.kind}`)}
                  </span>
                  {variant.note && (
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      {t("learnerPanel.teaching.help.noteQuoted", { note: variant.note })}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 whitespace-pre-line text-xs leading-5 text-foreground/90">
                  {variant.text}
                </p>
                {variant.example && (
                  <blockquote className="mt-1.5 border-l-2 border-border pl-2.5 text-xs leading-5 text-muted-foreground">
                    {variant.example}
                  </blockquote>
                )}
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {label ?? t("learnerPanel.teaching.help.sourceFull")}
                  {chapterIndex !== null && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onNavigateToChapter(chapterIndex)}
                      >
                        {t("learnerPanel.teaching.help.backToSource")}
                      </button>
                    </>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
        {t("learnerPanel.teaching.help.boundaryNote")}
      </p>
    </div>
  );
}
