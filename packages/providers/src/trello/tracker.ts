import { type HttpClient, ProviderError } from '../http';
import type {
  IntegrationId,
  Issue,
  IssueFilter,
  IssueTracker,
  ListPage,
  MyIssue,
  ProviderUser,
} from '../types';
import { enc, integrationFor, toIso } from '../bitbucket/shared';

/**
 * Trello as an IssueTracker (spec 10 §5.3, spec 11 §6.4): boards are scopes, cards are issues,
 * lists are states (moving a card to another list is a "transition"). Card key = shortLink.
 *
 * Scope = `"{boardId}/{boardName}"` (only the id part is used; the name keeps Launchpad rows
 * readable). A bare board id / shortLink is accepted too.
 *
 * HttpClient baseUrl: `https://api.trello.com/1`, Authorization from `TRELLO_AUTH.authHeader`.
 */

export interface TrelloTrackerOptions {
  http: HttpClient;
  integration?: IntegrationId;
}

export interface TrelloMember {
  id: string;
  username?: string;
  fullName?: string;
  avatarUrl?: string | null;
}
export interface TrelloList {
  id: string;
  name: string;
  closed?: boolean;
  pos?: number;
}
export interface TrelloBoard {
  id: string;
  name: string;
  shortLink?: string;
  url?: string;
  closed?: boolean;
  lists?: TrelloList[];
}
export interface TrelloCard {
  id: string;
  idShort?: number;
  shortLink: string;
  name: string;
  desc?: string;
  closed?: boolean;
  idBoard: string;
  idList: string;
  idMembers?: string[];
  members?: TrelloMember[];
  labels?: Array<{ id?: string; name?: string; color?: string | null }>;
  due?: string | null;
  dueComplete?: boolean;
  dateLastActivity?: string;
  url?: string;
  shortUrl?: string;
  badges?: { comments?: number };
  list?: TrelloList;
  board?: Pick<TrelloBoard, 'id' | 'name'>;
}

const CARD_FIELDS =
  'id,idShort,shortLink,name,desc,closed,idBoard,idList,idMembers,labels,due,dueComplete,dateLastActivity,url,shortUrl,badges';
const PAGE = 50;

/** Board id of a scope (`"{id}/{name}"`, `"{id}"`). */
export const trelloBoardId = (scope: string): string => {
  const s = scope.trim();
  const i = s.indexOf('/');
  return i < 0 ? s : s.slice(0, i);
};

export const trelloScope = (b: Pick<TrelloBoard, 'id' | 'name'>): string => `${b.id}/${b.name}`;

/** Card creation time from its Mongo-style id (first 8 hex digits = epoch seconds). */
export function trelloIdTime(id: string): string | undefined {
  if (!/^[0-9a-f]{24}$/i.test(id)) return undefined;
  return new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString();
}

/** Lists have no workflow category in Trello; derive one from well-known list names. */
export function trelloStateCategory(listName: string | undefined, closed?: boolean): Issue['stateCategory'] {
  if (closed) return 'done';
  const n = (listName ?? '').toLowerCase();
  if (/\b(done|complete[d]?|closed|shipped|released|finished|archive[d]?)\b/.test(n)) return 'done';
  if (/\b(doing|in progress|progress|wip|review|testing|qa|working|started|active)\b/.test(n))
    return 'in_progress';
  return 'todo';
}

export function createTrelloTracker(o: TrelloTrackerOptions): IssueTracker {
  const { http } = o;
  const integration = integrationFor('trello', 'trello.com', o.integration);
  let mePromise: Promise<TrelloMember> | null = null;
  const me = (): Promise<TrelloMember> => {
    mePromise ??= http.get<TrelloMember>('members/me', {
      query: { fields: 'id,username,fullName,avatarUrl' },
    });
    mePromise.catch(() => (mePromise = null));
    return mePromise;
  };

  const userOf = (m: TrelloMember): ProviderUser => ({
    id: m.id,
    login: m.username ?? m.id,
    name: m.fullName,
    avatarUrl: m.avatarUrl ? `${m.avatarUrl}/50.png` : undefined,
  });

  function toIssue(
    card: TrelloCard,
    board: Pick<TrelloBoard, 'id' | 'name'> | undefined,
    list?: TrelloList,
  ): Issue {
    const b = board ?? card.board ?? { id: card.idBoard, name: card.idBoard };
    const l = list ?? card.list;
    const members = card.members ?? [];
    return {
      tracker: { kind: 'trello', integration, scope: trelloScope(b) },
      key: card.shortLink,
      id: card.id,
      title: card.name,
      body: card.desc ?? '',
      bodyFormat: 'markdown',
      state: card.closed ? 'Archived' : (l?.name ?? ''),
      stateCategory: trelloStateCategory(l?.name, card.closed),
      type: 'Card',
      assignees: members.length
        ? members.map(userOf)
        : (card.idMembers ?? []).map((id) => ({ id, login: id })),
      labels: (card.labels ?? []).map((x) => x.name || x.color || '').filter(Boolean),
      milestone: card.due ? `Due ${card.due.slice(0, 10)}` : undefined,
      createdAt: trelloIdTime(card.id) ?? toIso(card.dateLastActivity) ?? '',
      updatedAt: toIso(card.dateLastActivity) ?? '',
      webUrl: card.shortUrl ?? card.url ?? `https://trello.com/c/${card.shortLink}`,
      commentsCount: card.badges?.comments,
    };
  }

  /** Open boards of the viewer with their open lists (one call; used to label cards). */
  async function boards(): Promise<TrelloBoard[]> {
    return http.get<TrelloBoard[]>('members/me/boards', {
      query: {
        filter: 'open',
        fields: 'id,name,shortLink,url,closed',
        lists: 'open',
        list_fields: 'id,name,pos',
      },
    });
  }

  async function board(id: string): Promise<TrelloBoard> {
    return http.get<TrelloBoard>(`boards/${enc(id)}`, {
      query: { fields: 'id,name,shortLink,url', lists: 'open', list_fields: 'id,name,pos' },
    });
  }

  const listIndex = (bs: TrelloBoard[]): Map<string, { board: TrelloBoard; list?: TrelloList }> => {
    const out = new Map<string, { board: TrelloBoard; list?: TrelloList }>();
    for (const b of bs) for (const l of b.lists ?? []) out.set(l.id, { board: b, list: l });
    return out;
  };

  async function getCard(key: string): Promise<Issue> {
    const c = await http.get<TrelloCard>(`cards/${enc(key)}`, {
      query: {
        fields: CARD_FIELDS,
        members: 'true',
        member_fields: 'id,username,fullName,avatarUrl',
        list: 'true',
        board: 'true',
        board_fields: 'id,name',
      },
    });
    return toIssue(c, c.board);
  }

  return {
    kind: 'trello',

    async listScopes() {
      const bs = await boards();
      return bs.map((b) => ({ scope: trelloScope(b), label: b.name }));
    },

    async listIssues(scope, filter: IssueFilter, cursor): Promise<ListPage<Issue>> {
      const boardId = trelloBoardId(scope);
      if (!boardId) throw new ProviderError({ code: 'validation', message: 'Pick a Trello board.' });
      const [b, cards, viewer] = await Promise.all([
        board(boardId),
        http.get<TrelloCard[]>(`boards/${enc(boardId)}/cards`, {
          query: {
            filter: 'open',
            fields: CARD_FIELDS,
            members: 'true',
            member_fields: 'id,username,fullName,avatarUrl',
          },
        }),
        me(),
      ]);
      const lists = new Map((b.lists ?? []).map((l) => [l.id, l]));
      const preset = filter.preset ?? 'assigned';
      let rows = cards.filter((c) => !c.closed);
      if (preset === 'assigned' || preset === 'created')
        rows = rows.filter((c) => (c.idMembers ?? []).includes(viewer.id));
      const q = filter.query?.trim().toLowerCase();
      if (q) rows = rows.filter((c) => `${c.name}\n${c.desc ?? ''}`.toLowerCase().includes(q));
      if (filter.updatedSince) {
        const since = Date.parse(filter.updatedSince);
        if (!Number.isNaN(since)) rows = rows.filter((c) => Date.parse(c.dateLastActivity ?? '') >= since);
      }
      rows.sort((a, c) => (c.dateLastActivity ?? '').localeCompare(a.dateLastActivity ?? ''));
      const start = cursor ? Number(cursor) || 0 : 0;
      return {
        items: rows.slice(start, start + PAGE).map((c) => toIssue(c, b, lists.get(c.idList))),
        nextCursor: start + PAGE < rows.length ? String(start + PAGE) : undefined,
        total: rows.length,
      };
    },

    getIssue: (_scope, key) => getCard(key),

    /** `GET /1/members/me/cards?filter=open` (+ board filter from `scopes`) — spec 11 §6.4. */
    async searchMyIssues(opts = {}) {
      const [cards, bs] = await Promise.all([
        http.get<TrelloCard[]>('members/me/cards', {
          query: {
            filter: 'open',
            fields: CARD_FIELDS,
            members: 'true',
            member_fields: 'id,username,fullName,avatarUrl',
          },
        }),
        boards().catch(() => [] as TrelloBoard[]),
      ]);
      const byList = listIndex(bs);
      const byBoard = new Map(bs.map((b) => [b.id, b]));
      const wanted = opts.scopes?.length ? new Set(opts.scopes.map(trelloBoardId)) : null;
      const rows = cards
        .filter((c) => !c.closed)
        .filter((c) => {
          if (!wanted) return true;
          const b = byBoard.get(c.idBoard);
          return wanted.has(c.idBoard) || (!!b?.shortLink && wanted.has(b.shortLink));
        })
        .sort((a, c) => (c.dateLastActivity ?? '').localeCompare(a.dateLastActivity ?? ''))
        .slice(0, opts.limit ?? 200);
      return rows.map((c): MyIssue => {
        const hit = byList.get(c.idList);
        return {
          issue: toIssue(c, hit?.board ?? byBoard.get(c.idBoard), hit?.list),
          involvement: ['assignee'],
        };
      });
    },

    async createIssue(scope, input) {
      const b = await board(trelloBoardId(scope));
      const list = [...(b.lists ?? [])].sort((x, y) => (x.pos ?? 0) - (y.pos ?? 0))[0];
      if (!list)
        throw new ProviderError({ code: 'validation', message: `The board “${b.name}” has no open lists.` });
      const c = await http.post<TrelloCard>('cards', {
        idList: list.id,
        name: input.title,
        desc: input.body ?? '',
        ...(input.assignees?.length ? { idMembers: input.assignees.join(',') } : {}),
      });
      return toIssue(c, b, list);
    },

    async updateIssue(_scope, key, patch) {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.name = patch.title;
      if (patch.body !== undefined) body.desc = patch.body;
      if (patch.assignees !== undefined) body.idMembers = patch.assignees.join(',');
      if (Object.keys(body).length) await http.put(`cards/${enc(key)}`, body);
      return getCard(key);
    },

    /** "Transitions" = the board's open lists (moving the card) plus archiving it. */
    async listTransitions(scope, key) {
      const boardId = trelloBoardId(scope) || (await getCard(key)).tracker.scope.split('/')[0]!;
      const b = await board(boardId);
      return [
        ...(b.lists ?? []).map((l) => ({
          id: `list:${l.id}`,
          name: `Move to ${l.name}`,
          toCategory: trelloStateCategory(l.name),
        })),
        { id: 'archive', name: 'Archive card', toCategory: 'done' as const },
      ];
    },

    async transition(_scope, key, transitionId) {
      if (transitionId === 'archive') await http.put(`cards/${enc(key)}`, { closed: true });
      else if (transitionId.startsWith('list:'))
        await http.put(`cards/${enc(key)}`, { idList: transitionId.slice(5) });
      else throw new ProviderError({ code: 'validation', message: `Unknown transition ${transitionId}.` });
    },

    async addComment(_scope, key, body) {
      await http.post(`cards/${enc(key)}/actions/comments`, { text: body });
    },

    async listComments(_scope, key) {
      const r = await http.get<
        Array<{ id: string; date: string; data?: { text?: string }; memberCreator?: TrelloMember }>
      >(`cards/${enc(key)}/actions`, { query: { filter: 'commentCard', limit: 100 } });
      return r
        .map((a) => ({
          id: a.id,
          author: a.memberCreator ? userOf(a.memberCreator) : { id: '', login: 'unknown' },
          body: a.data?.text ?? '',
          createdAt: toIso(a.date) ?? '',
        }))
        .reverse();
    },
  };
}
