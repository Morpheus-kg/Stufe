// Схемы zod для M8b: запросы к роутам и ответы модели.
import { z } from 'zod';

export const KINDS = ['ru_de', 'de_ru', 'transform'];
export const LEVELS = ['B1', 'B2', 'C1'];
export const FOCUS_VALUES = ['nebensatz', 'passiv', 'konjunktiv2', 'relativsatz', 'nominalisierung', 'indirekte_rede', 'konnektoren'];
export const PROVIDER_CHOICES = [
  'auto', 'groq', 'gemini', 'openrouter',
  'gemini:strong', 'gemini:fast', 'groq:strong', 'groq:fast', 'openrouter:strong', 'openrouter:fast',
];

// '' и null считаем отсутствующим значением
const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());
const nullToEmpty = (schema) => z.preprocess((v) => (v === null || v === undefined ? '' : v), schema);

// ---------- запросы ----------
export const setRequestSchema = z.object({
  kind: z.enum(KINDS),
  count: blank(z.number().int().min(3).max(10)),
  level: blank(z.enum(LEVELS)),
  topic: blank(z.string().trim().max(50)),
  focus: blank(z.enum(FOCUS_VALUES)),
  card_ids: blank(z.array(z.number().int().positive()).max(8)),
  provider: blank(z.enum(PROVIDER_CHOICES)),
});

export const checkRequestSchema = z.object({
  answers: z.array(z.object({
    idx: z.number().int().min(1).max(50),
    answer: nullToEmpty(z.string().max(600)),
  })).max(20),
  provider: blank(z.enum(PROVIDER_CHOICES)),
});

export const basketRequestSchema = z.object({
  kind: z.literal('basket'),
  items: z.array(z.object({
    idx: z.number().int().min(1).max(1000),
    source: z.string().trim().min(1).max(400),
    answer: z.string().trim().min(1).max(600),
    reference: blank(z.string().max(600)),
    card_id: blank(z.number().int().positive()),
  })).min(1).max(12),
  provider: blank(z.enum(PROVIDER_CHOICES)),
});

export const retellTaskRequestSchema = z.object({
  topic: blank(z.string().trim().max(80)),
  level: blank(z.enum(LEVELS)),
  sentences: blank(z.number().int().min(5).max(10)),
  use_due_words: blank(z.boolean()),
  provider: blank(z.enum(PROVIDER_CHOICES)),
});

export const retellEvaluateRequestSchema = z.object({
  task_id: z.number().int().positive(),
  text: z.string().min(30).max(3000),
  seconds: blank(z.number().int().min(0).max(86400)),
  provider: blank(z.enum(PROVIDER_CHOICES)),
});

// ---------- ответы модели (мягкие: чистка в коде) ----------
export const setGeneratedSchema = z.object({
  items: z.array(z.object({
    source_text: z.string(),
    reference: z.string(),
    instruction_ru: z.string().nullable().optional(),
    card_id: z.number().nullable().optional(),
  })).min(1),
});

const errorSchema = z.object({
  category: z.string().optional(),
  original: z.string().optional(),
  fix: z.string().optional(),
  explanation_ru: z.string().optional(),
});

export const checkResponseSchema = z.object({
  results: z.array(z.object({
    idx: z.number(),
    is_acceptable: z.boolean().optional(),
    score: z.number().optional(),
    corrected: z.string().nullable().optional(),
    model_translation: z.string().nullable().optional(),
    errors: z.array(errorSchema).optional(),
    used_target_words: z.array(z.number()).optional(),
    comment_ru: z.string().nullable().optional(),
  })),
  summary: z.object({
    tips: z.array(z.object({ category: z.string(), tip_ru: z.string() })).optional(),
    strengths_ru: z.array(z.string()).optional(),
    focus_ru: z.array(z.string()).optional(),
    overall_ru: z.string().nullable().optional(),
  }).optional(),
});

export const retellTaskGeneratedSchema = z.object({
  prompt_ru: z.string().min(20),
  key_points: z.array(z.string()).min(1),
  model_text: z.string().min(20),
});

export const retellEvalSchema = z.object({
  criteria: z.object({
    content: z.number(), coherence: z.number(), vocabulary: z.number(), grammar: z.number(),
  }),
  key_points: z.array(z.object({
    n: z.number(),
    conveyed: z.boolean(),
    comment_ru: z.string().nullable().optional(),
  })).optional(),
  errors: z.array(errorSchema).optional(),
  corrected_text: z.string().nullable().optional(),
  improvements_ru: z.array(z.string()).optional(),
  not_german: z.boolean().optional(),
});