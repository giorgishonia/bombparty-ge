-- Run this in Supabase SQL editor before enabling ranked mode.

create table if not exists public.player_profiles (
    id text primary key,
    display_name text not null default 'Player',
    mmr integer not null default 1000,
    highest_mmr integer not null default 1000,
    wins integer not null default 0,
    losses integer not null default 0,
    games_played integer not null default 0,
    ranked_games integer not null default 0,
    total_guessed_words bigint not null default 0,
    best_game_words integer not null default 0,
    longest_game_seconds integer not null default 0,
    total_game_seconds bigint not null default 0,
    total_score bigint not null default 0,
    updated_at timestamptz not null default now()
);

create index if not exists idx_player_profiles_mmr on public.player_profiles (mmr desc);
create index if not exists idx_player_profiles_words on public.player_profiles (total_guessed_words desc);
create index if not exists idx_player_profiles_longest on public.player_profiles (longest_game_seconds desc);

create table if not exists public.ranked_matches (
    id uuid primary key,
    lobby_code text,
    is_ranked boolean not null default false,
    started_at timestamptz not null default now(),
    ended_at timestamptz not null default now(),
    turns_elapsed integer not null default 0,
    total_words integer not null default 0,
    duration_seconds integer not null default 0,
    winner_player_id text,
    participant_ids text[] not null default '{}',
    rankings jsonb not null default '[]'::jsonb
);

create index if not exists idx_ranked_matches_ended_at on public.ranked_matches (ended_at desc);
create index if not exists idx_ranked_matches_participant_ids on public.ranked_matches using gin (participant_ids);
create index if not exists idx_ranked_matches_ranked on public.ranked_matches (is_ranked);

-- If RLS is enabled, add policies allowing your server role/key to read/write.
