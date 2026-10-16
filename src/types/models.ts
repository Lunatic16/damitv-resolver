export type Source = {
  source: string;
  id: string;
};

export type TeamSide = {
  name: string;
  badge: string;
};

export type EventTeams = {
  home: TeamSide;
  away: TeamSide;
};

export type Match = {
  id: string;
  title: string;
  category: string;
  league: string;
  date: number;
  status: string;
  alwaysLive: boolean;
  popular: boolean;
  poster: string;
  teams: EventTeams;
  viewers: number;
  embedUrl: string;
  sources: Source[];
};

export type Sport = { id: string; name: string };

export type StreamLink = {
  id: string;
  streamNo: number;
  language: string;
  hd: boolean;
  embedUrl: string;
  source: string;
  viewers: number;
};

export type ResolveOk = {
  ok: true;
  matchId?: string;
  title?: string;
  source: string;
  id: string;
  embedUrl: string;
  m3u8: string;
  referer: string;
  relay: string;
};

export type ResolveResult =
  | ResolveOk
  | {
      ok: false;
      stage: string;
      error: string;
    };
