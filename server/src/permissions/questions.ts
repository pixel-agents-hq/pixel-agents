import type {
  PermissionAnswer,
  PermissionQuestion,
  PermissionQuestionOption,
} from '../../../core/src/messages.js';
import {
  QUESTION_MAX_OPTIONS,
  QUESTION_MAX_QUESTIONS,
  QUESTION_OTHER_MAX_CHARS,
  QUESTION_TEXT_MAX_CHARS,
} from './constants.js';
import { capText } from './permissionDetail.js';

/**
 * AskUserQuestion through the board. Claude Code fires PermissionRequest for
 * it, but "allow" alone does not answer it: the answers go back in
 * `updatedInput.answers`, a map from question text to the chosen option
 * label (several labels joined with ", "). The board only ever sends option
 * INDICES and free text; the map is built by whoever holds the ORIGINAL tool
 * input (the hook script, or the relay for a remote session), so a question
 * the payload trimmed on the way to the board still keys the right answer.
 */
export const QUESTION_TOOL_NAME = 'AskUserQuestion';

/** How Claude Code joins a multi-select answer's labels. */
export const ANSWER_LABEL_SEPARATOR = ', ';

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The raw `questions` array of an AskUserQuestion input, or undefined. */
function rawQuestions(toolInput: unknown): Record<string, unknown>[] | undefined {
  if (toolInput === null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return undefined;
  }
  const questions = (toolInput as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  if (questions.length > QUESTION_MAX_QUESTIONS) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const q of questions) {
    if (q === null || typeof q !== 'object' || Array.isArray(q)) return undefined;
    const record = q as Record<string, unknown>;
    if (!str(record.question)) return undefined;
    if (!Array.isArray(record.options) || record.options.length > QUESTION_MAX_OPTIONS) {
      return undefined;
    }
    for (const o of record.options) {
      if (o === null || typeof o !== 'object' || !str((o as Record<string, unknown>).label)) {
        return undefined;
      }
    }
    out.push(record);
  }
  return out;
}

/** The questions the card shows, or undefined when this request is not a
 *  well-formed AskUserQuestion (then it is an ordinary Allow / Deny card). */
export function parseQuestions(
  toolName: string,
  toolInput: unknown,
): PermissionQuestion[] | undefined {
  if (toolName !== QUESTION_TOOL_NAME) return undefined;
  const questions = rawQuestions(toolInput);
  if (!questions) return undefined;
  return questions.map((q) => {
    const options: PermissionQuestionOption[] = (q.options as Record<string, unknown>[]).map(
      (o) => {
        const option: PermissionQuestionOption = {
          label: capText(str(o.label)!, QUESTION_TEXT_MAX_CHARS),
        };
        const description = str(o.description);
        if (description) option.description = capText(description, QUESTION_TEXT_MAX_CHARS);
        return option;
      },
    );
    const question: PermissionQuestion = {
      question: capText(str(q.question)!, QUESTION_TEXT_MAX_CHARS),
      multiSelect: q.multiSelect === true,
      options,
    };
    const header = str(q.header);
    if (header) question.header = capText(header, QUESTION_TEXT_MAX_CHARS);
    return question;
  });
}

/** A question's shape as the answer check needs it. */
interface QuestionShape {
  multiSelect: boolean;
  optionCount: number;
}

/**
 * `answers` checked against the questions: one per question, option indices
 * in range and distinct (at most one for a single-select question), "Other"
 * text trimmed and capped, and every question answered somehow. A fresh copy,
 * or null when anything is off. Client-supplied, so nothing is assumed.
 */
export function validateAnswers(
  questions: readonly QuestionShape[],
  answers: unknown,
): PermissionAnswer[] | null {
  if (!Array.isArray(answers) || answers.length !== questions.length) return null;
  const out: PermissionAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const raw = answers[i] as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { options, other } = raw as { options?: unknown; other?: unknown };
    if (!Array.isArray(options)) return null;
    const picked = new Set<number>();
    for (const index of options) {
      if (!Number.isInteger(index)) return null;
      const n = index as number;
      if (n < 0 || n >= questions[i].optionCount || picked.has(n)) return null;
      picked.add(n);
    }
    if (!questions[i].multiSelect && picked.size > 1) return null;
    if (other !== undefined && typeof other !== 'string') return null;
    const otherText = other?.trim() ?? '';
    if (otherText.length > QUESTION_OTHER_MAX_CHARS) return null;
    if (picked.size === 0 && !otherText) return null;
    const answer: PermissionAnswer = { options: [...picked].sort((a, b) => a - b) };
    if (otherText) answer.other = otherText;
    out.push(answer);
  }
  return out;
}

/** The shapes validateAnswers checks against, from parsed questions. */
export function questionShapes(questions: readonly PermissionQuestion[]): QuestionShape[] {
  return questions.map((q) => ({ multiSelect: q.multiSelect, optionCount: q.options.length }));
}

/**
 * The `answers` map Claude Code reads, built from the ORIGINAL tool input:
 * question text → chosen labels (and any "Other" text) joined with ", ".
 * Null when the input is not an AskUserQuestion or the answers don't fit it.
 */
export function answersForToolInput(
  toolInput: unknown,
  answers: unknown,
): Record<string, string> | null {
  const questions = rawQuestions(toolInput);
  if (!questions) return null;
  const valid = validateAnswers(
    questions.map((q) => ({
      multiSelect: q.multiSelect === true,
      optionCount: (q.options as unknown[]).length,
    })),
    answers,
  );
  if (!valid) return null;
  const map: Record<string, string> = {};
  questions.forEach((q, i) => {
    const options = q.options as Record<string, unknown>[];
    const { options: picked, other } = valid[i];
    const parts = picked.map((n) => str(options[n].label)!);
    if (other) parts.push(other);
    map[str(q.question)!] = parts.join(ANSWER_LABEL_SEPARATOR);
  });
  return map;
}

/** One line for approvals.log: "header: answer; header: answer". */
export function answersSummary(
  questions: readonly PermissionQuestion[],
  answers: readonly PermissionAnswer[],
): string {
  return questions
    .map((q, i) => {
      const { options: picked, other } = answers[i];
      const parts = picked.map((n) => q.options[n].label);
      if (other) parts.push(other);
      return `${q.header ?? q.question}: ${parts.join(ANSWER_LABEL_SEPARATOR)}`;
    })
    .join('; ');
}
