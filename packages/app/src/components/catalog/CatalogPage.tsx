import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { installAndOpenBundledBook } from "@/lib/catalog/acquire";
import { getCatalogEdition, getCatalogStats, queryCatalog } from "@/lib/catalog/repository";
import type { CatalogSeedManifest } from "@/lib/catalog/seed";
import { ensureCatalogSeeded } from "@/lib/catalog/seed";
import {
  CATALOG_SUBJECTS,
  type CatalogAvailability,
  type CatalogEdition,
  type CatalogStats,
} from "@readany/core/catalog";
import { cn } from "@readany/core/utils";
import { BookMarked, ExternalLink, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * 发现书库 (Discover Catalog) — the LIB-1 built-in library.
 *
 * Real, multi-discipline catalog snapshot shipped with the installer.
 * Bundled complete books open directly through the existing import + Reader
 * path; online entries link to their official pages. Works fully offline and
 * without any API key.
 */

const PAGE_SIZE = 40;

const AVAILABILITY_FILTERS: Array<{ id: CatalogAvailability | ""; labelKey: string }> = [
  { id: "", labelKey: "catalog.filterAll" },
  { id: "bundled", labelKey: "catalog.availability.bundled" },
  { id: "online", labelKey: "catalog.availability.online" },
];

function availabilityBadgeClass(availability: CatalogAvailability): string {
  switch (availability) {
    case "bundled":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "online":
      return "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400";
    default:
      return "border-muted-foreground/30 bg-muted text-muted-foreground";
  }
}

export function CatalogPage() {
  const { t } = useTranslation();

  const [seedError, setSeedError] = useState<string | null>(null);
  const [manifest, setManifest] = useState<CatalogSeedManifest | null>(null);
  const [stats, setStats] = useState<CatalogStats | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [availability, setAvailability] = useState<CatalogAvailability | "">("");

  const [editions, setEditions] = useState<CatalogEdition[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CatalogEdition | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

  // Debounce the search box into the committed query.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchInput = (value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setQuery(value);
      setPage(1);
    }, 250);
  };

  useEffect(() => {
    ensureCatalogSeeded()
      .then((res) => {
        setManifest(res.manifest);
        return getCatalogStats();
      })
      .then(setStats)
      .catch((err) => {
        console.error("[catalog] seed failed:", err);
        setSeedError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    if (seedError) return;
    let cancelled = false;
    setLoading(true);
    queryCatalog({
      q: query,
      subjectId: subjectId || undefined,
      availability: availability || undefined,
      page,
      pageSize: PAGE_SIZE,
    })
      .then((res) => {
        if (cancelled) return;
        // Page 1 replaces; higher pages append (加载更多 keeps prior results).
        setEditions((prev) => (page === 1 ? res.editions : [...prev, ...res.editions]));
        setTotal(res.total);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[catalog] query failed:", err);
          setEditions([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, subjectId, availability, page, seedError]);

  const openDetail = useCallback(async (edition: CatalogEdition) => {
    setDetailId(edition.catalogEditionId);
    setDetail(null);
    try {
      setDetail(await getCatalogEdition(edition.catalogEditionId));
    } catch (err) {
      console.warn("[catalog] detail load failed:", err);
      setDetail(edition);
    }
  }, []);

  const handleRead = useCallback(
    async (edition: CatalogEdition) => {
      setInstallingId(edition.catalogEditionId);
      try {
        await installAndOpenBundledBook(edition, t);
      } finally {
        setInstallingId(null);
      }
    },
    [t],
  );

  const subjectOptions = useMemo(
    () =>
      CATALOG_SUBJECTS.map((s) => ({
        id: s.id,
        zh: s.zh,
        count: stats?.bySubject[s.id] ?? 0,
      })),
    [stats],
  );

  if (seedError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <BookMarked className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">{t("catalog.seedErrorTitle", "书库数据未就绪")}</p>
        <p className="max-w-md text-xs text-muted-foreground">{seedError}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 space-y-2 border-b px-4 pb-3 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <h1 className="text-base font-semibold">{t("catalog.title")}</h1>
          {stats && (
            <p className="text-xs text-muted-foreground">
              {t("catalog.statsLine", {
                total: stats.totalEditions.toLocaleString(),
                bundled: stats.bundledCount,
                works: manifest ? manifest.counts.totalEditions.toLocaleString() : "…",
                date: stats.builtAt.slice(0, 10),
              })}
            </p>
          )}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => handleSearchInput(e.target.value)}
            placeholder={t("catalog.searchPlaceholder")}
            className="h-8 pl-8 text-sm"
          />
        </div>
        {/* Availability filter */}
        <div className="flex flex-wrap items-center gap-1">
          {AVAILABILITY_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setAvailability(f.id);
                setPage(1);
              }}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                availability === f.id
                  ? "border-foreground bg-foreground text-background"
                  : "border-transparent bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {t(f.labelKey)}
            </button>
          ))}
          {query || subjectId || availability ? (
            <button
              type="button"
              className="rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSearchInput("");
                setQuery("");
                setSubjectId("");
                setAvailability("");
                setPage(1);
              }}
            >
              {t("catalog.clearFilters")}
            </button>
          ) : null}
        </div>
        {/* Subject chips */}
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => {
              setSubjectId("");
              setPage(1);
            }}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              subjectId === ""
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t("catalog.subjectAll")}
          </button>
          {subjectOptions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setSubjectId(s.id);
                setPage(1);
              }}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                subjectId === s.id
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {s.zh}
              <span className="ml-1 opacity-60">{s.count > 0 ? s.count : ""}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : editions.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
            <p className="text-sm text-muted-foreground">{t("catalog.emptyTitle")}</p>
            <p className="text-xs text-muted-foreground/70">{t("catalog.emptyHint")}</p>
          </div>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              {t("catalog.resultCount", { count: total })}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {editions.map((edition) => (
                <CatalogCard
                  key={edition.catalogEditionId}
                  edition={edition}
                  installing={installingId === edition.catalogEditionId}
                  onOpen={() => void openDetail(edition)}
                  onRead={() => void handleRead(edition)}
                />
              ))}
            </div>
            {editions.length < total && (
              <div className="mt-4 flex justify-center pb-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("catalog.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Detail dialog */}
      <CatalogDetailDialog
        edition={detail}
        open={detailId !== null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
        installing={detail ? installingId === detail.catalogEditionId : false}
        onRead={detail ? () => void handleRead(detail) : undefined}
      />
    </div>
  );
}

function CatalogCard({
  edition,
  installing,
  onOpen,
  onRead,
}: {
  edition: CatalogEdition;
  installing: boolean;
  onOpen: () => void;
  onRead: () => void;
}) {
  const { t } = useTranslation();
  const displayTitle = edition.titleZh || edition.originalTitle;
  const showOriginal =
    edition.titleZh && edition.titleZh !== edition.originalTitle ? edition.originalTitle : null;
  const subjects = CATALOG_SUBJECTS.filter((s) => edition.subjectIds.includes(s.id));

  return (
    <div
      className="group relative flex h-full cursor-pointer flex-col items-start gap-1.5 rounded-lg border bg-background p-3 text-left transition-colors hover:bg-muted/50"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span className="line-clamp-2 text-sm font-medium leading-snug">{displayTitle}</span>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 rounded-full text-[10px]",
            availabilityBadgeClass(edition.resource.availability),
          )}
        >
          {t(`catalog.availability.${edition.resource.availability}`)}
        </Badge>
      </div>
      {showOriginal && (
        <span className="line-clamp-1 text-xs text-muted-foreground">{showOriginal}</span>
      )}
      <span className="line-clamp-1 text-xs text-muted-foreground">
        {edition.authors.length > 0 ? edition.authors.join(" / ") : t("catalog.unknownAuthor")}
      </span>
      <div className="flex flex-wrap gap-1">
        {subjects.slice(0, 3).map((s) => (
          <span
            key={s.id}
            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {s.zh}
          </span>
        ))}
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {t(`catalog.lang.${edition.language}`, edition.language)}
        </span>
      </div>
      <div className="mt-auto flex w-full items-center justify-between pt-1">
        <span className="truncate text-[10px] text-muted-foreground/70">
          {[edition.publisher, edition.year ? String(edition.year) : null]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {edition.resource.availability === "bundled" && (
          <button
            type="button"
            className="rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-foreground hover:text-background"
            onClick={(e) => {
              e.stopPropagation();
              onRead();
            }}
          >
            {installing ? (
              <Loader2 className="inline h-3 w-3 animate-spin" />
            ) : (
              t("catalog.readNow")
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function CatalogDetailDialog({
  edition,
  open,
  onOpenChange,
  installing,
  onRead,
}: {
  edition: CatalogEdition | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installing: boolean;
  onRead?: () => void;
}) {
  const { t } = useTranslation();
  if (!edition) return null;
  const displayTitle = edition.titleZh || edition.originalTitle;
  const isReferenceTitle = edition.titleZhSource === "reference";
  const subjects = CATALOG_SUBJECTS.filter((s) => edition.subjectIds.includes(s.id));
  const licenseIsRestricted = /NC|NonCommercial/i.test(edition.resource.licenseId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-left leading-snug">{displayTitle}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {edition.titleZh && edition.titleZh !== edition.originalTitle && (
            <p className="text-xs text-muted-foreground">
              {edition.originalTitle}
              {isReferenceTitle && (
                <span className="ml-1 opacity-70">（{t("catalog.referenceTitle")}）</span>
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {edition.authors.length > 0 ? edition.authors.join(" / ") : t("catalog.unknownAuthor")}
          </p>

          <div className="flex flex-wrap gap-1">
            <Badge
              variant="outline"
              className={cn(
                "rounded-full text-[10px]",
                availabilityBadgeClass(edition.resource.availability),
              )}
            >
              {t(`catalog.availability.${edition.resource.availability}`)}
            </Badge>
            {subjects.map((s) => (
              <span
                key={s.id}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {s.zh}
              </span>
            ))}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {t(`catalog.lang.${edition.language}`, edition.language)}
            </span>
            {edition.level !== "unknown" && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t(`catalog.level.${edition.level}`, edition.level)}
              </span>
            )}
          </div>

          {edition.descriptionZh && (
            <p className="text-xs leading-relaxed text-foreground/90">{edition.descriptionZh}</p>
          )}

          {edition.publisher && (
            <p className="text-xs text-muted-foreground">
              {edition.publisher}
              {edition.year ? ` · ${edition.year}` : ""}
            </p>
          )}

          {edition.toc && edition.toc.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium">{t("catalog.toc")}</p>
              <ol className="max-h-40 list-inside list-decimal space-y-0.5 overflow-y-auto rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                {edition.toc.map((item) => (
                  <li key={item} className="line-clamp-1">
                    {item}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* License and source — kept visible per plan §7. */}
          <div className="space-y-1 rounded-md border p-2 text-[11px] text-muted-foreground">
            <p>
              {t("catalog.license")}: {edition.resource.licenseId}
            </p>
            {edition.resource.attribution && <p>{edition.resource.attribution}</p>}
            {licenseIsRestricted && <p>{t("catalog.ncLicenseNote")}</p>}
            {edition.resource.landingUrl && (
              <a
                href={edition.resource.landingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 hover:opacity-80"
                onClick={(e) => e.stopPropagation()}
              >
                {t("catalog.sourcePage")}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          <div className="flex justify-end gap-2">
            {edition.resource.availability === "bundled" ? (
              <Button size="sm" disabled={installing} onClick={onRead}>
                {installing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  t("catalog.installAndRead")
                )}
              </Button>
            ) : edition.resource.availability === "online" ? (
              <p className="self-center text-xs text-muted-foreground">{t("catalog.onlineHint")}</p>
            ) : (
              <p className="self-center text-xs text-muted-foreground">
                {t("catalog.metadataOnlyHint")}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
