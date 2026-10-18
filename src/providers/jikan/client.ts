import { HTTPException } from "hono/http-exception";
import { env } from "../../config/env.js";
import { log } from "../../config/logger.js";
import { jikanLimiter } from "../../lib/rateLimiter.js";
import type {
  JikanAnime,
  JikanAnimeFull,
  JikanEpisode,
  JikanManga,
  JikanMangaFull,
  JikanCharacter,
} from "./types.js";

export class JikanClient {
  private base: string;

  constructor() {
    this.base = env.JIKAN_BASE_URL.replace(/\/$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    await jikanLimiter.acquire(1);
    const url = `${this.base}${path.startsWith("/") ? path : `/${path}`}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new HTTPException(503, { message: "Jikan metadata is temporarily unavailable. Please retry later." });
    }
    if (!res.ok) {
      log.warn({ url, status: res.status }, "Jikan HTTP error");
      throw new HTTPException(res.status === 404 ? 404 : 502, { message: `Jikan metadata request failed (HTTP ${res.status})` });
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new HTTPException(502, { message: "Jikan returned invalid metadata" });
    }
  }

  async getAnimeFull(malId: number): Promise<JikanAnimeFull> {
    const data = await this.get<{ data: JikanAnimeFull }>(`/anime/${malId}/full`);
    return data.data;
  }

  async getAnimeEpisodes(malId: number, page = 1): Promise<{ data: JikanEpisode[]; pagination: { has_next_page: boolean; last_visible_page: number } }> {
    return this.get(`/anime/${malId}/episodes?page=${page}`);
  }

  async getMangaFull(malId: number): Promise<JikanMangaFull> {
    try {
      const data = await this.get<{ data: JikanMangaFull }>(`/manga/${malId}/full`);
      return data.data;
    } catch (error) {
      // Full enrichment can fail while the basic metadata endpoint still works.
      if (!(error instanceof HTTPException) || error.status !== 502) throw error;
      return this.getMangaById(malId);
    }
  }

  async getMangaById(malId: number): Promise<JikanManga> {
    const data = await this.get<{ data: JikanManga }>(`/manga/${malId}`);
    return data.data;
  }

  async getMangaCharacters(malId: number): Promise<JikanCharacter[]> {
    const data = await this.get<{ data: JikanCharacter[] }>(`/manga/${malId}/characters`);
    return data.data;
  }

  async searchAnime(q: string, page = 1, limit = 20): Promise<{ data: JikanAnime[]; pagination: { has_next_page: boolean; last_visible_page: number; current_page: number; items: { total: number; count: number; per_page: number } } }> {
    return this.get(`/anime?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}&order_by=members&sort=desc`);
  }

  async searchManga(q: string, page = 1, limit = 20): Promise<{ data: JikanManga[]; pagination: { has_next_page: boolean; last_visible_page: number; current_page: number; items: { total: number; count: number; per_page: number } } }> {
    return this.get(`/manga?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}&order_by=members&sort=desc`);
  }

  async topAnime(page: number, limit: number, filter: "airing" | "upcoming" | "bypopularity" | "favorite") {
    return this.get<{ data: JikanAnime[]; pagination: { has_next_page: boolean; last_visible_page: number; current_page: number; items: { total: number; count: number; per_page: number } } }>(
      `/top/anime?page=${page}&limit=${limit}&filter=${filter}`,
    );
  }

  async seasonNow(year: number, season: string, page = 1, limit = 25) {
    return this.get<{ data: JikanAnime[]; pagination: { has_next_page: boolean; last_visible_page: number; current_page: number; items: { total: number; count: number; per_page: number } } }>(
      `/seasons/${year}/${season.toLowerCase()}?page=${page}&limit=${limit}`,
    );
  }
}

export const jikanClient = new JikanClient();
