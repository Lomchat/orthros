import React from "react";
import {
  GearSix,
  MagnifyingGlass,
  Folder,
  FolderPlus,
  GridFour,
  List,
  ArrowsDownUp,
  CaretDown,
  UploadSimple,
  Play,
  PencilSimple,
  X,
  GithubLogo,
} from "@phosphor-icons/react";
import type { AddedGame } from "../wgb-library";
import { formatBytes } from "../storage-manager";
import { cx } from "../ui/cx";
import FlagIcon from "./FlagIcon";
import GameSettingsModal from "./GameSettingsModal";
import {
  loadGameProfile,
  saveGameProfile,
  resolveLanguage,
  type GameLanguage,
  type GameProfile,
} from "../game-profile";
import s from "./GameSelectScreen.module.css";
import ib from "../ui/IconButton/IconButton.module.css";
import bm from "../ui/Button/Button.module.css";

export interface GameEntry {
  id: string;
  name: string;
  subtitle: string;
  wgbUrl: string;
  sizeBytes?: number;
  description: string;
  year: string;
  genre: string;
  coverUrl: string;
  os?: string;
  render?: string;
  status?: "ready" | "setup" | "save";
  gogUrl?: string;
  /** Languages the bundle ships. Each one is a separate install (own gameId/container). */
  languages?: GameLanguage[];
  defaultLanguage?: string;
}

interface GameSelectScreenProps {
  games: GameEntry[];
  addedGames?: AddedGame[];
  onSelectGame: (game: GameEntry) => void;
  onPlayAdded?: (game: AddedGame) => void;
  onRemoveAdded?: (game: AddedGame) => void;
  onEditAdded?: (game: AddedGame) => void;
  onAddGame: () => void;
  onDevMode: () => void;
  onManageStorage?: () => void;
  onOpenSettings?: () => void;
  accountControl?: React.ReactNode;
  disableSelection?: boolean;
  unsupportedMessage?: string | null;
  /** Banner heading above unsupportedMessage. Defaults to the browser-capability wording. */
  unsupportedTitle?: string;
}

type SourceFilter = "all" | "builtin" | "gog" | "local";
type SortMode = "added" | "played" | "title" | "year";
type ViewMode = "grid" | "list";

const SORT_LABELS: Record<SortMode, string> = {
  added: "Recently added",
  played: "Recently played",
  title: "Title (A–Z)",
  year: "Year",
};

function isGogAdded(game: AddedGame): boolean {
  const hay = `${game.key} ${game.url}`.toLowerCase();
  return hay.includes("gog");
}

export default function GameSelectScreen({
  games,
  addedGames = [],
  onSelectGame,
  onPlayAdded,
  onRemoveAdded,
  onEditAdded,
  onAddGame,
  onDevMode,
  onManageStorage,
  onOpenSettings,
  accountControl,
  disableSelection = false,
  unsupportedMessage = null,
  unsupportedTitle = "Unsupported browser",
}: GameSelectScreenProps) {
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<ViewMode>("grid");
  const [source, setSource] = React.useState<SourceFilter>("all");
  const [sort, setSort] = React.useState<SortMode>("added");
  const [srcMenuOpen, setSrcMenuOpen] = React.useState(false);
  const [sortMenuOpen, setSortMenuOpen] = React.useState(false);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const srcWrapRef = React.useRef<HTMLDivElement>(null);
  const sortWrapRef = React.useRef<HTMLDivElement>(null);

  const openSettings = onOpenSettings ?? onManageStorage ?? (() => {});
  // Per-game profiles live in localStorage; App re-reads them at launch, so the modal only
  // has to keep this view in sync.
  const [profiles, setProfiles] = React.useState<Record<string, GameProfile>>({});
  const [configuring, setConfiguring] = React.useState<GameEntry | null>(null);
  React.useEffect(() => {
    const next: Record<string, GameProfile> = {};
    for (const g of games) if (g.languages?.length) next[g.id] = loadGameProfile(g.id);
    setProfiles(next);
  }, [games]);
  const totalGames = games.length + addedGames.length;

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
    if (!srcMenuOpen && !sortMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!srcWrapRef.current?.contains(t) && !sortWrapRef.current?.contains(t)) {
        setSrcMenuOpen(false);
        setSortMenuOpen(false);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [srcMenuOpen, sortMenuOpen]);

  const q = query.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);

  const visibleBuiltin =
    source === "all" || source === "builtin" ? games.filter((g) => matches(g.name)) : [];
  const visibleAdded =
    source === "all" || source === "local" || source === "gog"
      ? addedGames.filter((g) => {
          if (source === "gog" && !isGogAdded(g)) return false;
          if (source === "local" && isGogAdded(g)) return false;
          return matches(g.name);
        })
      : [];

  const builtinCount = games.length;
  const gogCount = addedGames.filter(isGogAdded).length;
  const localCount = addedGames.length - gogCount;

  const isFirstRun = addedGames.length === 0 && games.length === 0;

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
          <span className={s["brand__fork"]}>
            Inspired by and forked from{" "}
            <a href="https://bottleship.pages.dev/" target="_blank" rel="noopener noreferrer">
              BottleShip
            </a>
            .
          </span>
        </div>
        <span className={s["cmd-spacer"]} />
        <div className={s["cmd-actions"]}>
          {accountControl}
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
          <div className={s["hero__t"]}>Turn classic Windows games into browser-playable packages.</div>
          <div className={s["hero__h"]}>
            Drop a GOG installer, a folder, a ZIP, or a .wgb file. Games run locally with
            WebAssembly + WebGPU; signed-in players can sync saves to their private cloud account.
          </div>
          <div className={s["hero__cta"]}>
            <button className={cx(bm, "btn", "btn--primary")} onClick={() => !disableSelection && onAddGame()} disabled={disableSelection}>
              + Add your first game
            </button>
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
                placeholder="Search games, packages, installers…"
              />
              <kbd>/</kbd>
            </label>

            <div ref={srcWrapRef} className={s["srcwrap"]}>
              <button
                className={s["srcsel"]}
                onClick={(e) => {
                  e.stopPropagation();
                  setSrcMenuOpen((o) => !o);
                  setSortMenuOpen(false);
                }}
              >
                <Folder size={15} aria-hidden />
                {source === "all"
                  ? "All sources"
                  : source === "builtin"
                  ? "Built-in"
                  : source === "gog"
                  ? "GOG"
                  : "Local files"}
                <CaretDown className={s["caret"]} size={14} aria-hidden />
              </button>
              <div className={cx(s, "menu", srcMenuOpen && "is-open")}>
                <div
                  className={cx(s, "menuitem", source === "all" && "is-active")}
                  onClick={() => {
                    setSource("all");
                    setSrcMenuOpen(false);
                  }}
                >
                  All sources <span className={s["ct"]}>{totalGames}</span>
                </div>
                <div
                  className={cx(s, "menuitem", source === "builtin" && "is-active")}
                  onClick={() => {
                    setSource("builtin");
                    setSrcMenuOpen(false);
                  }}
                >
                  <span className={s["dotc"]} style={{ background: "var(--cyan)" }} /> Built-in{" "}
                  <span className={s["ct"]}>{builtinCount}</span>
                </div>
                <div
                  className={cx(s, "menuitem", source === "gog" && "is-active")}
                  onClick={() => {
                    setSource("gog");
                    setSrcMenuOpen(false);
                  }}
                >
                  <span className={s["dotc"]} style={{ background: "var(--amber)" }} /> GOG{" "}
                  <span className={s["ct"]}>{gogCount}</span>
                </div>
                <div
                  className={cx(s, "menuitem", source === "local" && "is-active")}
                  onClick={() => {
                    setSource("local");
                    setSrcMenuOpen(false);
                  }}
                >
                  <span className={s["dotc"]} style={{ background: "var(--violet)" }} /> Local files{" "}
                  <span className={s["ct"]}>{localCount}</span>
                </div>
                <div
                  className={cx(s, "menuitem", "menuitem--mount")}
                  onClick={() => {
                    setSrcMenuOpen(false);
                    onManageStorage?.();
                  }}
                >
                  <FolderPlus size={14} aria-hidden /> Mount a folder…
                </div>
              </div>
            </div>

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
                  setSrcMenuOpen(false);
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
            <article
              className={cx(s, "card", "card--add")}
              style={{ animationDelay: "0ms" }}
              onClick={() => !disableSelection && onAddGame()}
              role="button"
              tabIndex={disableSelection ? -1 : 0}
              onKeyDown={(e) => {
                if (!disableSelection && (e.key === "Enter" || e.key === " ")) onAddGame();
              }}
            >
              <div className={s["add-body"]}>
                <div className={s["add-glyph"]}>
                  <UploadSimple size={24} aria-hidden />
                </div>
                <div className={s["add-title"]}>Add a game</div>
                <div className={s["add-hint"]}>
                  Drop a .wgb package, GOG
                  <br />
                  installer, ZIP, or folder
                </div>
              </div>
            </article>

            {visibleBuiltin.map((game, i) => (
              <BuiltinCard
                key={game.id}
                game={game}
                index={i + 1}
                onPlay={() => onSelectGame(game)}
                profile={profiles[game.id] ?? {}}
                onConfigure={() => setConfiguring(game)}
                disabled={disableSelection}
              />
            ))}

            {visibleAdded.map((game, i) => (
              <AddedCard
                key={`byo:${game.key}`}
                game={game}
                index={visibleBuiltin.length + i + 1}
                onPlay={() => onPlayAdded?.(game)}
                onRemove={() => onRemoveAdded?.(game)}
                onEdit={() => onEditAdded?.(game)}
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
            <span className={s["priv"]}>Games run locally · signed-in saves can sync privately</span>
            <span className={s["sep"]}>·</span>
            <a onClick={() => onManageStorage?.()}>Storage</a>
            <span className={s["sep"]}>·</span>
            <a onClick={() => !disableSelection && onDevMode()}>Developer</a>
          </div>
        </div>
      )}

      <GameSettingsModal
        isOpen={configuring !== null}
        title={configuring?.name ?? ""}
        languages={configuring?.languages}
        defaultLanguage={configuring?.defaultLanguage}
        profile={configuring ? (profiles[configuring.id] ?? {}) : {}}
        onApply={(next) => {
          if (!configuring) return;
          saveGameProfile(configuring.id, next);
          setProfiles((prev) => ({ ...prev, [configuring.id]: next }));
        }}
        onClose={() => setConfiguring(null)}
      />
    </div>
  );
}

function countLabel(n: number): string {
  return `${n} ${n === 1 ? "game" : "games"}`;
}

function specLine(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" · ");
}

function GameCardMeta({ sizeBytes, year }: { sizeBytes?: number; year?: string | number }): React.ReactElement {
  return (
    <span className={s["card__meta"]}>
      {typeof sizeBytes === "number" && <span className={s["card__size"]}>{formatBytes(sizeBytes)}</span>}
      <span className={s["card__year"]}>{year ?? "—"}</span>
    </span>
  );
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
  profile,
  onConfigure,
  disabled,
}: {
  game: GameEntry;
  index: number;
  onPlay: () => void;
  profile: GameProfile;
  onConfigure: () => void;
  disabled: boolean;
}): React.ReactElement {
  // A configured language rebrands the card: its own title, cover and flag.
  const language = resolveLanguage(game.languages, profile, game.defaultLanguage);
  const name = language?.name ?? game.name;
  const coverUrl = language?.coverUrl ?? game.coverUrl;
  const configurable = (game.languages?.length ?? 0) > 0;
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
          coverUrl={coverUrl}
          name={name}
          badge={<span className={cx(s, "badge", "badge--builtin")}>Built-in</span>}
        />
        {language ? (
          <span className={s["card__flag"]} title={language.label}>
            <FlagIcon country={language.flag} title={language.label} />
          </span>
        ) : null}
        {configurable && !disabled ? (
          <button
            className={s["card__cog"]}
            title="Game settings"
            aria-label={`Settings for ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              onConfigure();
            }}
          >
            <GearSix size={16} aria-hidden />
          </button>
        ) : null}
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
        <div className={s["card__name"]}>{name}</div>
        <div className={s["card__spec"]}>{specLine([game.genre, game.os, game.render])}</div>
        <div className={s["card__foot"]}>
          <StatusPill status={game.status} />
          <GameCardMeta sizeBytes={game.sizeBytes} year={game.year} />
        </div>
      </div>
    </article>
  );
}

function AddedCard({
  game,
  index,
  onPlay,
  onRemove,
  onEdit,
  disabled,
}: {
  game: AddedGame;
  index: number;
  onPlay: () => void;
  onRemove: () => void;
  onEdit: () => void;
  disabled: boolean;
}): React.ReactElement {
  const gog = isGogAdded(game);
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
          badge={
            <span className={cx(s, "badge", gog ? "badge--gog" : "badge--local")}>{gog ? "GOG" : "Local"}</span>
          }
        />
        <div className={s["card__tools"]}>
          <button
            className={s["tool"]}
            title="Edit manifest"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <PencilSimple size={13} aria-hidden />
          </button>
          <button
            className={cx(s, "tool", "tool--danger")}
            title="Remove from library"
            onClick={(e) => {
              e.stopPropagation();
              if (
                confirm(
                  `Remove "${game.name}" from your library? The cached bundle is deleted (re-add anytime).`,
                )
              ) {
                onRemove();
              }
            }}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
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
        <div className={s["card__spec"]}>{specLine([game.developer, ".wgb package"])}</div>
        <div className={s["card__foot"]}>
          <StatusPill status="ready" />
          <GameCardMeta sizeBytes={game.sizeBytes} year={game.year} />
        </div>
      </div>
    </article>
  );
}
