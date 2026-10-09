/**
 * Authoring through `POST /projects/{p}/commits?branchId={b}`.
 *
 * Four measured rules shape every payload here, and each one cost a beat of the
 * AAKI thread to learn:
 *
 *  1. **Derived properties are rejected, not ignored.** A payload echoing back
 *     what a GET returned fails the whole commit with a 500 that names the value
 *     and not the field. So a change carries `@type`, `@id` and the properties
 *     being set. Nothing else.
 *  2. **An update merges.** Omitted properties survive, so there is never a
 *     read-before-write — which is also what makes rule 1 free rather than a
 *     sacrifice.
 *  3. **Creation takes two commits.** Ids are assigned by the server and are not
 *     in the response, so the subgraph is created first and wired second.
 *  4. **Wiring an owned element takes three directions**, not two: the
 *     membership's two ends, the element's forward `ownedRelationship`, and the
 *     element's `owningRelationship` back at the membership. Relationships
 *     themselves never carry the third.
 */
import { expectOk } from './classify.js';
import type { PostHttp } from './query.js';

export interface DataVersion {
  '@type': 'DataVersion';
  identity?: { '@id': string };
  payload: Record<string, unknown>;
}

export interface CommitBody {
  '@type': 'Commit';
  description: string;
  change: DataVersion[];
}

/** One element to create. No `identity`: the server assigns the id. */
export interface CreateSpec { type: string; props?: Record<string, unknown> }

/** One element to change. `set` carries ONLY what is changing (rules 1 and 2). */
export interface UpdateSpec { id: string; type: string; set: Record<string, unknown> }

/**
 * Create elements, in one commit, with no `identity`.
 *
 * **Nothing extra is sent.** An earlier version set `projectId` here, after a
 * link written without it failed to appear on the OSLC AM surface and appeared
 * once it was set. That inference was wrong twice over: the value does not
 * persist through a create, and the same link later became visible with
 * `projectId` still null. The real behaviour is in `verifyOnAmSurface` below.
 */
export function buildCreateCommit(description: string, specs: CreateSpec[]): CommitBody {
  return {
    '@type': 'Commit',
    description,
    change: specs.map((s) => ({
      '@type': 'DataVersion' as const,
      payload: { '@type': s.type, ...(s.props ?? {}) },
    })),
  };
}

export function buildUpdateCommit(description: string, specs: UpdateSpec[]): CommitBody {
  return {
    '@type': 'Commit',
    description,
    change: specs.map((s) => ({
      '@type': 'DataVersion' as const,
      identity: { '@id': s.id },
      // `@id` repeated inside the payload is not redundant: on an update the
      // element id is taken from `payload.@id`, not from `identity.@id`, though
      // both are validated.
      payload: { '@type': s.type, '@id': s.id, ...s.set },
    })),
  };
}

/** The ids involved in attaching one owned element to its owner. */
export interface Wiring {
  /** The element that will own it. */
  owner: string;
  ownerType: string;
  /** Every relationship the owner will own, INCLUDING the new membership —
   *  `ownedRelationship` is set, not appended, so the caller supplies the whole
   *  list. Dropping the existing ones is the easiest way to orphan a subtree. */
  ownerRelationships: string[];
  membership: string;
  /** `OwningMembership` for documentation and links; `FeatureMembership` for a
   *  part that is a feature of its owner. */
  membershipType: 'OwningMembership' | 'FeatureMembership';
  owned: string;
  ownedType: string;
  /** Relationships the owned element itself owns, if any (its own documentation
   *  membership, a typing). Omitted leaves them untouched — an update merges. */
  ownedRelationships?: string[];
}

/**
 * The second commit of a creation: attach an element to its owner.
 *
 * All three directions (rule 4). Setting only the membership's ends leaves an
 * element that reads back perfectly over the API and is invisible in the UI;
 * omitting the third as well leaves one that differs from every element RSE
 * made itself, which is harder to notice and worse to debug.
 */
export function buildWireCommit(description: string, w: Wiring): CommitBody {
  return buildUpdateCommit(description, [
    { id: w.membership, type: w.membershipType,
      set: { visibility: 'public',
             owningRelatedElement: { '@id': w.owner },
             ownedRelatedElement: [{ '@id': w.owned }] } },
    { id: w.owned, type: w.ownedType,
      set: { owningRelationship: { '@id': w.membership },
             ...(w.ownedRelationships
               ? { ownedRelationship: w.ownedRelationships.map((id) => ({ '@id': id })) }
               : {}) } },
    { id: w.owner, type: w.ownerType,
      set: { ownedRelationship: w.ownerRelationships.map((id) => ({ '@id': id })) } },
  ]);
}

/** POST a commit and return its id, classifying by payload rather than status. */
export async function postCommit(
  http: PostHttp, baseUrl: string, projectId: string, branchId: string, body: CommitBody
): Promise<string> {
  const r = await http.post(
    `${baseUrl}/projects/${projectId}/commits?branchId=${encodeURIComponent(branchId)}`,
    body, { headers: { 'Content-Type': 'application/json' } });
  const c = expectOk<{ '@id'?: string; '@type'?: string }>(
    r.status, r.data, `RSE commit "${body.description}"`);
  if (c['@type'] !== 'Commit' || !c['@id']) {
    throw new Error(
      `RSE: the commit "${body.description}" did not come back as a Commit: ` +
      `${JSON.stringify(c).slice(0, 200)}`);
  }
  return c['@id'];
}

/**
 * Confirm a write on the OSLC AM surface, retrying, because a single look lies.
 *
 * A commit is visible over SysML the instant it returns. Its projection onto the
 * AM surface is **asynchronous and not reliably prompt**. Measured on the same
 * branch, writing the same kind of link three times:
 *
 *   - once visible at t+0, immediately after the wire commit;
 *   - once absent for ten seconds and present about a minute later;
 *   - once absent for a full sixty-two seconds of polling, and present roughly
 *     thirty seconds after that — all with no further writes.
 *
 * So the lag ranges from zero to around two minutes, and the mechanism was not
 * established — a projection cache or an async index are both consistent with
 * it, and no amount of staring at one response reveals which.
 *
 * **The design consequence is more useful than the measurement.** Verify a write
 * on the path you wrote through: the SysML side is authoritative and immediate.
 * The AM projection matters only to *other* clients — ELM, LQE — so it is worth
 * reporting, and worth waiting for when a downstream consumer is the point, but
 * it is the wrong thing to gate a write on. A verification that can fail for a
 * minute after a correct write invites the worst possible response, which is
 * writing the change again.
 *
 * This matters more than it sounds. Verification is the rule that makes writing
 * safe here, and a verification that can produce a false negative invites the
 * worst possible response: writing the change again.
 */
export async function verifyOnAmSurface(
  check: () => Promise<boolean>, attempts = 12, delayMs = 5000
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
