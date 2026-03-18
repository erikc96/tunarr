import { KEYS } from '@/types/inject.js';
import type { DrizzleDBAccess } from '@/db/schema/index.js';
import { Program } from '@/db/schema/Program.js';
import { ProgramGrouping } from '@/db/schema/ProgramGrouping.js';
import { Genre, EntityGenre } from '@/db/schema/Genre.js';
import { eq, like, inArray, gte, lte, sql, and, or, type SQL } from 'drizzle-orm';
import { injectable, inject } from 'inversify';

export interface MediaItem {
  uuid: string;
  title: string;
  showTitle: string | null;
  type: string;
  year: number | null;
  duration: number;
  seasonNumber: number | null;
  episode: number | null;
  summary: string | null;
  externalKey: string;
  mediaSourceId: string | null;
  plexRatingKey: string | null;
  plexFilePath: string | null;
  genres: string[];
}

interface ShowSummary {
  showTitle: string;
  episodeCount: number;
  seasons: number[];
  genres: string[];
}

interface Selection {
  type: 'show' | 'movie';
  title: string;
}

interface Hints {
  genres: string[];
  yearFrom: number | null;
  yearTo: number | null;
  searchTerms: string[];
}

const KNOWN_GENRES = [
  'comedy', 'drama', 'action', 'horror', 'thriller', 'sci-fi',
  'science fiction', 'romance', 'documentary', 'animation', 'fantasy',
  'mystery', 'crime', 'adventure', 'family', 'western', 'musical',
  'war', 'history', 'biography', 'sport', 'music', 'anime',
];

const GENRE_ALIASES: Record<string, string> = {
  'sitcom': 'comedy',
  'scary': 'horror',
  'suspense': 'thriller',
  'scifi': 'sci-fi',
  'rom-com': 'comedy',
  'romcom': 'comedy',
  'cartoon': 'animation',
  'animated': 'animation',
  'historical': 'history',
  'biographical': 'biography',
};

@injectable()
export class ContextBuilder {
  constructor(@inject(KEYS.DrizzleDB) private db: DrizzleDBAccess) {}

  async getStats(): Promise<string> {
    const total = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(Program)
      .then((r) => r[0]?.count ?? 0);

    const typeCounts = await this.db
      .select({
        type: Program.type,
        count: sql<number>`count(*)`,
      })
      .from(Program)
      .groupBy(Program.type);

    const yearCounts = await this.db
      .select({
        year: Program.year,
        count: sql<number>`count(*)`,
      })
      .from(Program)
      .where(sql`${Program.year} IS NOT NULL`)
      .groupBy(Program.year)
      .orderBy(sql`${Program.year} DESC`);

    const showCounts = await this.db
      .select({
        showTitle: sql<string>`COALESCE(${Program.showTitle}, ${ProgramGrouping.title})`.as('show_title_resolved'),
        count: sql<number>`count(*)`,
      })
      .from(Program)
      .leftJoin(ProgramGrouping, eq(Program.tvShowUuid, ProgramGrouping.uuid))
      .where(sql`COALESCE(${Program.showTitle}, ${ProgramGrouping.title}) IS NOT NULL`)
      .groupBy(sql`show_title_resolved`)
      .orderBy(sql`count(*) DESC`)
      .limit(50);

    const genreCounts = await this.db
      .select({
        name: Genre.name,
        count: sql<number>`count(*)`,
      })
      .from(EntityGenre)
      .innerJoin(Genre, eq(EntityGenre.genreId, Genre.uuid))
      .where(sql`${EntityGenre.programId} IS NOT NULL`)
      .groupBy(Genre.name)
      .orderBy(sql`count(*) DESC`)
      .limit(30);

    const lines = [`Library: ${total} items.`];
    lines.push(
      'Types: ' + typeCounts.map((t) => `${t.type}(${t.count})`).join(', '),
    );
    if (genreCounts.length > 0) {
      lines.push(
        'Top genres: ' +
          genreCounts.map((g) => `${g.name}(${g.count})`).join(', '),
      );
    }
    const decades = this.buildDecades(yearCounts);
    lines.push(
      'Decades: ' + decades.map((d) => `${d.decade}s(${d.count})`).join(', '),
    );
    if (showCounts.length > 0) {
      lines.push(
        'Top shows: ' +
          showCounts.map((s) => `${s.showTitle}(${s.count}ep)`).join(', '),
      );
    }
    return lines.join('\n');
  }

  async queryPrograms(opts: {
    type?: string;
    genres?: string[];
    yearFrom?: number;
    yearTo?: number;
    showTitle?: string;
    search?: string;
    limit?: number;
  }): Promise<MediaItem[]> {
    const conditions: SQL[] = [];

    if (opts.type) conditions.push(eq(Program.type, opts.type as 'movie' | 'episode'));
    if (opts.yearFrom) conditions.push(gte(Program.year, opts.yearFrom));
    if (opts.yearTo) conditions.push(lte(Program.year, opts.yearTo));
    if (opts.showTitle) {
      conditions.push(
        sql`LOWER(COALESCE(${Program.showTitle}, ${ProgramGrouping.title})) = LOWER(${opts.showTitle})`,
      );
    }
    if (opts.search) {
      const cond = or(
        like(Program.title, `%${opts.search}%`),
        like(Program.showTitle, `%${opts.search}%`),
      );
      if (cond) conditions.push(cond);
    }

    if (opts.genres && opts.genres.length > 0) {
      const genreRows = await this.db
        .select({ uuid: Genre.uuid })
        .from(Genre)
        .where(
          or(...opts.genres.map((g) => like(Genre.name, `%${g}%`))) ?? sql`1=0`,
        );
      if (genreRows.length > 0) {
        const genreIds = genreRows.map((g) => g.uuid);
        const programGenres = await this.db
          .select({ programId: EntityGenre.programId })
          .from(EntityGenre)
          .where(
            and(
              inArray(EntityGenre.genreId, genreIds),
              sql`${EntityGenre.programId} IS NOT NULL`,
            ) ?? sql`1=0`,
          );
        const programUuidsWithGenre = programGenres
          .map((pg) => pg.programId)
          .filter((id): id is string => id !== null);
        if (programUuidsWithGenre.length > 0) {
          conditions.push(inArray(Program.uuid, programUuidsWithGenre));
        } else {
          return [];
        }
      }
    }

    const where = conditions.length > 0 ? (and(...conditions) ?? undefined) : undefined;
    const rows = await this.db
      .select({
        uuid: Program.uuid,
        title: Program.title,
        showTitle: sql<string | null>`COALESCE(${Program.showTitle}, ${ProgramGrouping.title})`.as('show_title_resolved'),
        type: Program.type,
        year: Program.year,
        duration: Program.duration,
        seasonNumber: Program.seasonNumber,
        episode: Program.episode,
        summary: Program.summary,
        externalKey: Program.externalKey,
        mediaSourceId: Program.mediaSourceId,
        plexRatingKey: Program.plexRatingKey,
        plexFilePath: Program.plexFilePath,
      })
      .from(Program)
      .leftJoin(ProgramGrouping, eq(Program.tvShowUuid, ProgramGrouping.uuid))
      .where(where)
      .orderBy(Program.title)
      .limit(opts.limit ?? 500);

    return rows.map((r) => ({
      uuid: r.uuid,
      title: r.title,
      showTitle: r.showTitle,
      type: r.type,
      year: r.year,
      duration: r.duration,
      seasonNumber: r.seasonNumber,
      episode: r.episode,
      summary: r.summary,
      externalKey: r.externalKey,
      mediaSourceId: r.mediaSourceId ?? null,
      plexRatingKey: r.plexRatingKey ?? null,
      plexFilePath: r.plexFilePath ?? null,
      genres: [],
    }));
  }

  async getFilteredItems(prompt: string): Promise<MediaItem[]> {
    const hints = extractHints(prompt);
    let items: MediaItem[] = [];

    if (hints.genres.length > 0) {
      items = items.concat(
        await this.queryPrograms({ genres: hints.genres, limit: 500 }),
      );
    }
    if (hints.yearFrom && hints.yearTo) {
      items = items.concat(
        await this.queryPrograms({
          yearFrom: hints.yearFrom,
          yearTo: hints.yearTo,
          limit: 500,
        }),
      );
    }
    for (const term of hints.searchTerms) {
      items = items.concat(await this.queryPrograms({ search: term, limit: 200 }));
    }

    const seen = new Set<string>();
    items = items.filter((item) => {
      if (seen.has(item.uuid)) return false;
      seen.add(item.uuid);
      return true;
    });

    if (items.length === 0) {
      items = await this.queryPrograms({ limit: 500 });
    }

    return items;
  }

  buildSummaryList(items: MediaItem[]): string {
    const shows: Record<string, ShowSummary> = {};
    const movies: MediaItem[] = [];

    for (const item of items) {
      if (item.showTitle) {
        if (!shows[item.showTitle]) {
          shows[item.showTitle] = {
            showTitle: item.showTitle,
            episodeCount: 0,
            seasons: [],
            genres: item.genres,
          };
        }
        shows[item.showTitle]!.episodeCount++;
        if (
          item.seasonNumber &&
          !shows[item.showTitle]!.seasons.includes(item.seasonNumber)
        ) {
          shows[item.showTitle]!.seasons.push(item.seasonNumber);
        }
      } else {
        movies.push(item);
      }
    }

    const lines: string[] = [];
    for (const [, info] of Object.entries(shows).sort(
      (a, b) => b[1].episodeCount - a[1].episodeCount,
    )) {
      const seasons =
        info.seasons.length > 0
          ? `, seasons ${info.seasons.sort((a, b) => a - b).join(',')}`
          : '';
      lines.push(
        `SHOW: "${info.showTitle}" (${info.episodeCount} episodes${seasons})`,
      );
    }
    for (const m of movies) {
      lines.push(
        `MOVIE: "${m.title}" (${m.year ?? '?'}) ${Math.round(m.duration / 60000)}min uuid:${m.uuid}`,
      );
    }
    return lines.join('\n');
  }

  async expandSelections(
    selections: Selection[],
    excludeUuids?: Set<string>,
  ): Promise<MediaItem[]> {
    const result: MediaItem[] = [];
    const seen = excludeUuids ? new Set(excludeUuids) : new Set<string>();

    const showNames = selections
      .filter((s) => s.type === 'show')
      .map((s) => s.title);
    const movieTitles = selections
      .filter((s) => s.type === 'movie')
      .map((s) => s.title);

    for (const name of showNames) {
      const episodes = await this.queryPrograms({
        showTitle: name,
        limit: 10000,
      });
      for (const ep of episodes) {
        if (!seen.has(ep.uuid)) {
          seen.add(ep.uuid);
          result.push(ep);
        }
      }
    }

    for (const title of movieTitles) {
      const movies = await this.queryPrograms({ search: title, type: 'movie', limit: 10 });
      const titleLower = title.toLowerCase();
      for (const m of movies) {
        if (!seen.has(m.uuid) && m.title.toLowerCase() === titleLower) {
          seen.add(m.uuid);
          result.push(m);
        }
      }
    }

    return result;
  }

  private buildDecades(
    yearCounts: { year: number | null; count: number }[],
  ): { decade: number; count: number }[] {
    const map: Record<number, number> = {};
    for (const row of yearCounts) {
      if (!row.year) continue;
      const decade = Math.floor(row.year / 10) * 10;
      map[decade] = (map[decade] ?? 0) + row.count;
    }
    return Object.entries(map)
      .map(([decade, count]) => ({ decade: parseInt(decade), count }))
      .sort((a, b) => b.decade - a.decade);
  }
}

function extractHints(prompt: string): Hints {
  const lower = prompt.toLowerCase();
  const genres: string[] = [];
  for (const g of KNOWN_GENRES) {
    if (lower.includes(g)) genres.push(g);
  }
  for (const [alias, genre] of Object.entries(GENRE_ALIASES)) {
    if (lower.includes(alias) && !genres.includes(genre)) genres.push(genre);
  }

  let yearFrom: number | null = null;
  let yearTo: number | null = null;
  const decadeMatch = lower.match(/(\d{2,4})s/);
  if (decadeMatch?.[1]) {
    let decade = parseInt(decadeMatch[1]);
    if (decade < 100) decade = decade < 30 ? 2000 + decade : 1900 + decade;
    yearFrom = decade;
    yearTo = decade + 9;
  }
  const yearRange = lower.match(/(\d{4})\s*[-–to]+\s*(\d{4})/);
  if (yearRange?.[1] && yearRange[2]) {
    yearFrom = parseInt(yearRange[1]);
    yearTo = parseInt(yearRange[2]);
  }

  const searchTerms: string[] = [];
  const quoted = prompt.match(/"([^"]+)"/g);
  if (quoted) {
    searchTerms.push(...quoted.map((q) => q.replace(/"/g, '')));
  }

  return { genres, yearFrom, yearTo, searchTerms };
}
