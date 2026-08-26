import React from "react";
import {
  GearSix,
  MagnifyingGlass,
  GridFour,
  List,
  ArrowsDownUp,
  CaretDown,
  Play,
  GithubLogo,
} from "@phosphor-icons/react";
import { cx } from "../ui/cx";
import s from "./GameSelectScreen.module.css";
import ib from "../ui/IconButton/IconButton.module.css";
import bm from "../ui/Button/Button.module.css";

export interface GameEntry {
  id: string;
  name: string;
  subtitle: string;
  wgbUrl: string;
  description: string;
  year: string;
  genre: string;
  coverUrl: string;
  os?: string;
  render?: string;
  status?: "ready" | "setup" | "save";
  gogUrl?: string;
}

interface GameSelectScreenProps {
  games: GameEntry[];
  onSelectGame: (game: GameEntry) => void;
  onDevMode: () => void;
  onManageStorage?: () => void;
  onOpenSettings?: () => void;
  disableSelection?: boolean;
  unsupportedMessage?: string | null;
  /** Banner heading above unsupportedMessage. Defaults to the browser-capability wording. */
  unsupportedTitle?: string;
}

type SortMode = "added" | "played" | "title" | "year";
type ViewMode = "grid" | "list";

const SORT_LABELS: Record<SortMode, string> = {
  added: "Recently added",
  played: "Recently played",
  title: "Title (A–Z)",
  year: "Year",
};

export default function GameSelectScreen({
  games,
  onSelectGame,
  onDevMode,
  onManageStorage,
  onOpenSettings,
  disableSelection = false,
  unsupportedMessage = null,
  unsupportedTitle = "Unsupported browser",
}: GameSelectScreenProps) {
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<ViewMode>("grid");
  const [sort, setSort] = React.useState<SortMode>("added");
  const [sortMenuOpen, setSortMenuOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const sortWrapRef = React.useRef<HTMLDivElement>(null);

  const openSettings = onOpenSettings ?? onManageStorage ?? (() => {});
  const totalGames = games.length;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
    if (!sortMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!sortWrapRef.current?.contains(e.target as Node)) setSortMenuOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [sortMenuOpen]);

  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);

  const visibleBuiltin = games.filter((g) => matches(g.name));

  const isFirstRun = games.length === 0;

  return (
    <div className={s["shell"]}>
      <header className={s["cmdbar"]}>
        <div className={s["brand"]}>
          <div className={s["brand__mark"]}>
            <img src="/orthros_logo.png" className={s["brand__logo"]} alt="Orthros" />
            <span className={s["wordmark"]}>
              Orth<b>ros</b>
            </span>
          </div>
          <span className={s["brand__tag"]}>Run classic Windows games in your browser.</span>
        </div>
        <span className={s["cmd-spacer"]} />
        <div className={s["cmd-actions"]}>
          <a
            className={ib["iconbtn"]}
            href="https://github.com/Lomchat/orthros"
            target="_blank"
            rel="noopener noreferrer"
            title="View source on GitHub"
            aria-label="GitHub repository"
          >
            <GithubLogo size={18} weight="fill" aria-hidden />
          </a>
          <button className={ib["iconbtn"]} title="Settings" onClick={() => openSettings()}>
            <GearSix size={19} aria-hidden />
          </button>
        </div>
      </header>

      {isFirstRun ? (
        <section className={s["hero"]}>
          <img src="/orthros_logo.png" className={s["hero__logo"]} alt="Orthros" />
          <div className={s["hero__t"]}>Run classic Windows games in your browser.</div>
          <div className={s["hero__h"]}>
            The library is empty — no game bundle is published on this server yet.
          </div>
          {unsupportedMessage && (
            <div className={s["lib__unsupported"]} style={{ marginTop: 28, textAlign: "left" }}>
              <div className={s["lib__unsupported-title"]}>{unsupportedTitle}</div>
              <div>{unsupportedMessage}</div>
            </div>
          )}
        </section>
      ) : (
        <div>
          <div className={s["libhead"]}>
            <h2>Library</h2>
            <span className={s["sub"]}>{countLabel(totalGames)} · on this machine</span>
          </div>

          {unsupportedMessage && (
            <div className={s["lib__unsupported"]}>
              <div className={s["lib__unsupported-title"]}>{unsupportedTitle}</div>
              <div>{unsupportedMessage}</div>
            </div>
          )}

          <div className={s["filters"]}>
            <label className={s["search"]}>
              <MagnifyingGlass size={15} aria-hidden />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search games…"
              />
              <kbd>/</kbd>
            </label>

            <span className={s["filters__spacer"]} />

            <div className={s["viewtoggle"]}>
              <button
                className={cx(s, "vt", view === "grid" && "is-active")}
                title="Grid"
                onClick={() => setView("grid")}
              >
                <GridFour size={15} aria-hidden />
              </button>
              <button
                className={cx(s, "vt", view === "list" && "is-active")}
                title="List"
                onClick={() => setView("list")}
              >
                <List size={15} aria-hidden />
              </button>
            </div>

            <div ref={sortWrapRef} className={s["sortwrap"]}>
              <button
                className={s["sortsel"]}
                onClick={(e) => {
                  e.stopPropagation();
                  setSortMenuOpen((o) => !o);
                }}
              >
                <ArrowsDownUp size={14} aria-hidden />
                <span className={s["muted"]}>{SORT_LABELS[sort]}</span>
                <CaretDown className={s["caret"]} size={14} aria-hidden />
              </button>
              <div className={cx(s, "menu", "menu--right", sortMenuOpen && "is-open")}>
                {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                  <div
                    key={mode}
                    className={cx(s, "menuitem", sort === mode && "is-active")}
                    onClick={() => {
                      setSort(mode);
                      setSortMenuOpen(false);
                    }}
                  >
                    {SORT_LABELS[mode]}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className={cx(s, "shelf", view === "list" && "shelf--list")}>
            {visibleBuiltin.map((game, i) => (
              <BuiltinCard
                key={game.id}
                game={game}
                index={i + 1}
                onPlay={() => onSelectGame(game)}
                disabled={disableSelection}
              />
            ))}

          </div>

          <div className={s["statusbar"]}>
            <span className={s["ok"]}>WebGPU ready</span>
            <span className={s["sep"]}>·</span>
            <span>x86 HLE · WASM</span>
            <span className={s["sep"]}>·</span>
            <span>{countLabel(totalGames)}</span>
            <span className={s["spacer"]} />
            <span className={s["priv"]}>Local only — your games never leave this machine</span>
            <span className={s["sep"]}>·</span>
            <a onClick={() => onManageStorage?.()}>Storage</a>
            <span className={s["sep"]}>·</span>
            <a onClick={() => !disableSelection && onDevMode()}>Developer</a>
          </div>
        </div>
      )}
    </div>
  );
}

function countLabel(n: number): string {
  return `${n} ${n === 1 ? "game" : "games"}`;
}

function specLine(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function StatusPill({ status }: { status?: "ready" | "setup" | "save" }): React.ReactElement | null {
  if (status === "setup") return <span className={cx(s, "st", "st--setup")}>Needs setup</span>;
  if (status === "save") return <span className={cx(s, "st", "st--save")}>Save available</span>;
  return <span className={cx(s, "st", "st--ready")}>Ready</span>;
}

function Cover({
  coverUrl,
  name,
  badge,
}: {
  coverUrl?: string;
  name: string;
  badge: React.ReactNode;
}): React.ReactElement {
  const glyph = name.slice(0, 1).toUpperCase();
  return (
    <>
      <div className={s["card__fallback"]}>
        <span className={s["card__glyph"]}>{glyph}</span>
      </div>
      {coverUrl && (
        <img
          src={coverUrl}
          alt=""
          draggable={false}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      {badge}
    </>
  );
}

function BuiltinCard({
  game,
  index,
  onPlay,
  disabled,
}: {
  game: GameEntry;
  index: number;
  onPlay: () => void;
  disabled: boolean;
}): React.ReactElement {
  return (
    <article
      className={cx(s, "card", disabled && "card--disabled")}
      style={{ animationDelay: `${index * 40}ms` }}
      onClick={() => !disabled && onPlay()}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) onPlay();
      }}
    >
      <div className={s["card__cover"]}>
        <Cover
          coverUrl={game.coverUrl}
          name={game.name}
          badge={<span className={cx(s, "badge", "badge--builtin")}>Built-in</span>}
        />
        {game.subtitle ? <span className={cx(s, "badge", "badge--sub")}>{game.subtitle}</span> : null}
        <div className={s["card__play"]}>
          {disabled ? (
            <div className={s["card__locked"]}>Unavailable</div>
          ) : (
            <div className={s["play-btn"]}>
              <Play size={20} fill="currentColor" aria-hidden />
            </div>
          )}
        </div>
      </div>
      <div className={s["card__info"]}>
        <div className={s["card__name"]}>{game.name}</div>
        <div className={s["card__spec"]}>{specLine([game.genre, game.os, game.render])}</div>
        <div className={s["card__foot"]}>
          <StatusPill status={game.status} />
          <span className={s["card__year"]}>{game.year}</span>
        </div>
      </div>
    </article>
  );
}
