import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import {
  readJsonParsed,
  writeJsonAtomic,
  writeTextAtomic,
} from "../../lib/fs.js";

export interface OwnerSourceIdentity {
  source: string;
  userId: string;
}

export interface PersonalityProposal {
  id: string;
  mode: "update" | "reset";
  content: string;
  owner: OwnerSourceIdentity;
  createdAt: string;
}

const PersonalityProposalSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{12}$/),
  mode: z.enum(["update", "reset"]),
  content: z.string(),
  owner: z.object({
    source: z.string(),
    userId: z.string(),
  }),
  createdAt: z.string(),
});

export interface PersonalityDecision {
  action: "confirm" | "cancel";
  id: string;
}

export class PersonalityContentError extends Error {}

const INVALID_PERSONALITY_STRUCTURE_ERROR =
  "Personality changes can only define Role, Tone, and Communication Style.";
const UNSUPPORTED_PERSONALITY_TRAIT_ERROR =
  "Personality proposal contains unsupported role, tone, or communication-style values.";

export const PERSONALITY_ROLES = [
  "Personal secretary and assistant",
  "Assistant",
  "Personal assistant",
  "Executive assistant",
  "Professional assistant",
  "Technical assistant",
  "Research assistant",
  "Creative assistant",
  "General assistant",
  "Collaborative partner",
  "Advisor",
  "Coach",
  "Concierge",
] as const;

export const PERSONALITY_TONES = [
  "Polite and respectful",
  "Formal but warm (not stiff)",
  "Adaptive to context and conversation partner",
  "Formal",
  "Warm and respectful",
  "Direct and respectful",
  "Casual and friendly",
  "Calm and reassuring",
  "Empathetic and patient",
  "Neutral and objective",
  "Diplomatic and tactful",
  "Candid but considerate",
  "Energetic and enthusiastic",
  "Playful but respectful",
] as const;

export const PERSONALITY_COMMUNICATION_STYLES = [
  "Professional",
  "Proactive in helping",
  "Organized and structured",
  "Concise",
  "Proactive and concise",
  "Brief and action-oriented",
  "Detailed and thorough",
  "Conversational",
  "Plain-language",
  "Step-by-step",
  "Summary-first",
  "Collaborative",
  "Analytical",
  "Ask clarifying questions when needed",
  "Use short paragraphs",
  "Write concise responses",
] as const;

export type PersonalityRole = (typeof PERSONALITY_ROLES)[number];
export type PersonalityTone = (typeof PERSONALITY_TONES)[number];
export type PersonalityCommunicationStyle =
  (typeof PERSONALITY_COMMUNICATION_STYLES)[number];

const PERSONALITY_ROLE_SET: ReadonlySet<string> = new Set(PERSONALITY_ROLES);
const PERSONALITY_TONE_SET: ReadonlySet<string> = new Set(PERSONALITY_TONES);
const PERSONALITY_COMMUNICATION_STYLE_SET: ReadonlySet<string> = new Set(
  PERSONALITY_COMMUNICATION_STYLES,
);

export async function stagePersonalityProposal(
  cfg: AppConfig,
  input: {
    mode: "update" | "reset";
    content?: string;
    owner: OwnerSourceIdentity;
  },
): Promise<PersonalityProposal> {
  await recoverInterruptedPersonalityApply(cfg);
  const content =
    input.mode === "reset"
      ? await fs.readFile(
          path.resolve(import.meta.dirname, "../../PERSONALITY.md"),
          "utf8",
        )
      : input.content;
  if (!content?.trim()) {
    throw new PersonalityContentError(INVALID_PERSONALITY_STRUCTURE_ERROR);
  }
  const normalizedContent = renderPersonalityDocument(
    parsePersonalityDocument(content),
  );
  const proposal: PersonalityProposal = {
    id: crypto.randomBytes(6).toString("hex"),
    mode: input.mode,
    content: normalizedContent,
    owner: input.owner,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(pendingProposalPath(cfg), proposal);
  return proposal;
}

interface PersonalityDocument {
  role: PersonalityRole;
  tone: PersonalityTone[];
  communicationStyle: PersonalityCommunicationStyle[];
}

function parsePersonalityDocument(content: string): PersonalityDocument {
  const expectedHeadings = ["# Personality", "## Role", "## Tone", "## Communication Style"];
  const lines = content.trim().split(/\r?\n/);
  const headings = lines.filter((line) => /^#{1,6}\s/.test(line.trim()));
  const hasExpectedHeadings =
    headings.length === expectedHeadings.length &&
    headings.every(
      (heading, index) => heading.trim() === expectedHeadings[index],
    );
  const sectionLines = (heading: string): string[] => {
    const start = lines.findIndex((line) => line.trim() === heading);
    const next = lines.findIndex(
      (line, index) => index > start && /^#{1,6}\s/.test(line.trim()),
    );
    return lines
      .slice(start + 1, next < 0 ? undefined : next)
      .map((line) => line.trim())
      .filter(Boolean);
  };
  const roleLines = sectionLines("## Role");
  const toneLines = sectionLines("## Tone");
  const styleLines = sectionLines("## Communication Style");
  const bulletValues = (section: string[]): string[] | null => {
    if (section.length < 1 || section.length > 8) return null;
    const values = section.map((line) => line.match(/^-\s+(.+)$/)?.[1]?.trim());
    return values.every((value): value is string => Boolean(value)) ? values : null;
  };
  const tone = bulletValues(toneLines);
  const communicationStyle = bulletValues(styleLines);
  if (
    Buffer.byteLength(content, "utf8") > 16_384 ||
    content.includes("\0") ||
    !hasExpectedHeadings ||
    roleLines.length !== 1 ||
    !tone ||
    !communicationStyle
  ) {
    throw new PersonalityContentError(INVALID_PERSONALITY_STRUCTURE_ERROR);
  }
  return toControlledPersonalityDocument({
    role: roleLines[0]!,
    tone,
    communicationStyle,
  });
}

function toControlledPersonalityDocument(input: {
  role: string;
  tone: string[];
  communicationStyle: string[];
}): PersonalityDocument {
  if (
    !PERSONALITY_ROLE_SET.has(input.role) ||
    input.tone.some((value) => !PERSONALITY_TONE_SET.has(value)) ||
    input.communicationStyle.some(
      (value) => !PERSONALITY_COMMUNICATION_STYLE_SET.has(value),
    )
  ) {
    throw new PersonalityContentError(UNSUPPORTED_PERSONALITY_TRAIT_ERROR);
  }
  return input as PersonalityDocument;
}

function renderPersonalityDocument(document: PersonalityDocument): string {
  return [
    "# Personality",
    "",
    "## Role",
    "",
    document.role,
    "",
    "## Tone",
    "",
    ...document.tone.map((value) => `- ${value}`),
    "",
    "## Communication Style",
    "",
    ...document.communicationStyle.map((value) => `- ${value}`),
    "",
  ].join("\n");
}

export function formatPersonalityProposal(
  proposal: PersonalityProposal,
): string {
  const label =
    proposal.mode === "reset"
      ? "Personality reset proposed."
      : "Personality change proposed.";
  return [
    label,
    "",
    "Proposed PERSONALITY.md:",
    "",
    proposal.content.trimEnd(),
    "",
    `Reply exactly \`confirm personality ${proposal.id}\` to apply it or \`cancel personality ${proposal.id}\` to discard it.`,
  ].join("\n");
}

export function parsePersonalityDecision(
  text: string,
): PersonalityDecision | null {
  const match = text
    .trim()
    .match(/^(confirm|cancel)\s+personality\s+([a-f0-9]{12})$/i);
  if (!match) return null;
  return {
    action: match[1]!.toLowerCase() as PersonalityDecision["action"],
    id: match[2]!.toLowerCase(),
  };
}

export async function resolvePersonalityDecision(
  cfg: AppConfig,
  input: PersonalityDecision & { owner: OwnerSourceIdentity },
): Promise<
  | { kind: "applied"; mode: "update" | "reset" }
  | { kind: "cancelled" }
  | { kind: "stale" }
  | { kind: "unauthorized" }
> {
  const recovered = await recoverInterruptedPersonalityApply(cfg);
  if (
    recovered &&
    recovered.id === input.id &&
    sameOwner(recovered.owner, input.owner)
  ) {
    return { kind: "applied", mode: recovered.mode };
  }
  const pendingPath = pendingProposalPath(cfg);
  const proposal = await readJsonParsed(
    pendingPath,
    PersonalityProposalSchema,
    null,
  );
  if (!proposal || proposal.id !== input.id) return { kind: "stale" };
  if (!sameOwner(proposal.owner, input.owner)) {
    return { kind: "unauthorized" };
  }
  if (input.action === "cancel") {
    await fs.unlink(pendingPath);
    return { kind: "cancelled" };
  }
  const applyingPath = applyingProposalPath(cfg);
  await fs.rename(pendingPath, applyingPath);
  await applyPersonalityProposal(cfg, proposal, applyingPath);
  return { kind: "applied", mode: proposal.mode };
}

async function recoverInterruptedPersonalityApply(
  cfg: AppConfig,
): Promise<PersonalityProposal | null> {
  const applyingPath = applyingProposalPath(cfg);
  const proposal = await readJsonParsed(
    applyingPath,
    PersonalityProposalSchema,
    null,
  );
  if (!proposal) return null;
  await applyPersonalityProposal(cfg, proposal, applyingPath);
  return proposal;
}

async function applyPersonalityProposal(
  cfg: AppConfig,
  proposal: PersonalityProposal,
  applyingPath: string,
): Promise<void> {
  await writeTextAtomic(
    path.join(cfg.paths.root, "PERSONALITY.md"),
    proposal.content,
  );
  await fs.unlink(applyingPath);
}

function sameOwner(
  left: OwnerSourceIdentity,
  right: OwnerSourceIdentity,
): boolean {
  return left.source === right.source && left.userId === right.userId;
}

function pendingProposalPath(cfg: AppConfig): string {
  return path.join(cfg.paths.catalog, "personality-change.json");
}

function applyingProposalPath(cfg: AppConfig): string {
  return path.join(cfg.paths.catalog, "personality-change.applying.json");
}
