/**
 * "Autotests" for the public Shikimori GraphQL API, written like a QA team would:
 * each one checks a user-facing scenario. Note: Shikimori limits query depth to 5.
 */
export const tests = [
  {
    suite: 'каталог аниме',
    name: 'поиск аниме по названию',
    body: {
      query:
        'query Search($q: String!) { animes(search: $q, limit: 3) { id name russian score kind status episodes } }',
      variables: { q: 'Наруто' },
    },
    check: (d) => d.animes.length > 0,
  },
  {
    suite: 'каталог аниме',
    name: 'карточка тайтла',
    body: {
      query: `query Card($ids: String!) {
  animes(ids: $ids, limit: 1) {
    id russian description episodes rating
    airedOn { year month day }
    genres { name russian kind }
    studios { name }
    poster { mainUrl }
  }
}`,
      variables: { ids: '1' },
    },
    check: (d) => d.animes[0]?.id === '1',
  },
  {
    suite: 'каталог аниме',
    name: 'онгоинги по популярности',
    body: {
      query:
        'query Ongoing($status: AnimeStatusString, $order: OrderEnum) { animes(status: $status, order: $order, limit: 5) { russian episodesAired nextEpisodeAt } }',
      variables: { status: 'ongoing', order: 'popularity' },
    },
    check: (d) => Array.isArray(d.animes),
  },
  {
    suite: 'каталог аниме',
    name: 'персонажи тайтла',
    body: {
      query:
        '{ animes(ids: "20", limit: 1) { russian characterRoles { rolesRu character { russian } } } }',
    },
    check: (d) => d.animes[0]?.characterRoles?.length > 0,
  },
  {
    suite: 'манга',
    name: 'топ манги',
    body: {
      query:
        '{ mangas(order: ranked, limit: 5) { russian score volumes chapters kind publishers { name } } }',
    },
    check: (d) => d.mangas.length === 5,
  },
  {
    suite: 'персонажи и люди',
    name: 'поиск персонажа',
    body: {
      query:
        '{ characters(search: "Наруто", limit: 3) { russian isAnime isManga poster { miniUrl } } }',
    },
    check: (d) => d.characters.length > 0,
  },
  {
    suite: 'персонажи и люди',
    name: 'поиск режиссёра',
    body: {
      query:
        '{ people(search: "Миядзаки", isProducer: true, limit: 3) { russian isSeyu isProducer isMangaka birthOn { year } } }',
    },
    check: (d) => Array.isArray(d.people),
  },
  {
    suite: 'справочники',
    name: 'жанры аниме',
    body: { query: '{ genres(entryType: Anime) { id name russian kind } }' },
    check: (d) => d.genres.length > 10,
  },
  {
    suite: 'справочники',
    name: 'турниры',
    body: { query: '{ contests(limit: 2) { name state memberType startedOn } }' },
    check: (d) => Array.isArray(d.contests),
  },
  {
    suite: 'негативные',
    name: 'несуществующее поле',
    body: { query: '{ animes(limit: 1) { id notAField } }' },
    expectErrors: true,
  },
];
