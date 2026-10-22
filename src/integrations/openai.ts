import sharp from 'sharp';
import { z } from 'zod';

import type { AppLogger } from '../logging/logger.js';

export interface NumberImage {
  data: Buffer;
  contentType: string;
}

export interface NumberRecognizer {
  recognizeNumber(image: NumberImage): Promise<number | null>;
}

export interface OpenAINumberRecognizerOptions {
  apiKey: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  logger: AppLogger;
  fetchImplementation?: typeof fetch;
}

const recognitionSchema = z.object({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});

const FRAME_LIMIT = 4;

/**
 * Uses the OpenAI Responses API only as an image reader. The counting rules
 * remain local and deterministic in the counting-chain service.
 */
export class OpenAINumberRecognizer implements NumberRecognizer {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: OpenAINumberRecognizerOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async recognizeNumber(image: NumberImage): Promise<number | null> {
    const frames = await createPngFrames(image);
    const response = await this.fetchImplementation('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(this.options.timeoutMs),
      body: JSON.stringify({
        model: this.options.model,
        reasoning: { effort: this.options.reasoningEffort },
        store: false,
        max_output_tokens: 64,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Identify the single positive integer visibly shown in these image frames. Do not calculate or infer a number. If no single unambiguous positive integer is visible, return null.',
              },
              ...frames.map((frame) => ({
                type: 'input_image',
                detail: 'high',
                image_url: `data:image/png;base64,${frame.toString('base64')}`,
              })),
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'counting_chain_number',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                number: {
                  type: ['integer', 'null'],
                  minimum: 1,
                },
              },
              required: ['number'],
              additionalProperties: false,
            },
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI number recognition failed with HTTP ${response.status}`);
    }

    const body: unknown = await response.json();
    const outputText = readOutputText(body);
    if (!outputText) {
      throw new Error('OpenAI number recognition returned no structured output');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch (error: unknown) {
      throw new Error('OpenAI number recognition returned invalid JSON', { cause: error });
    }

    const result = recognitionSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error('OpenAI number recognition returned an invalid number result', {
        cause: result.error,
      });
    }

    return result.data.number;
  }
}

export function createOpenAINumberRecognizer(
  options: OpenAINumberRecognizerOptions,
): NumberRecognizer {
  return new OpenAINumberRecognizer(options);
}

async function createPngFrames(image: NumberImage): Promise<Buffer[]> {
  const isGif = image.contentType === 'image/gif';
  const metadata = await sharp(image.data, { animated: isGif }).metadata();
  const pageCount = isGif ? Math.max(1, metadata.pages ?? 1) : 1;
  const pages = samplePageIndexes(pageCount, FRAME_LIMIT);

  return Promise.all(
    pages.map((page) =>
      sharp(image.data, { animated: isGif, page })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer(),
    ),
  );
}

function samplePageIndexes(pageCount: number, limit: number): number[] {
  if (pageCount <= limit) {
    return Array.from({ length: pageCount }, (_, index) => index);
  }

  const indexes = new Set<number>([0, pageCount - 1]);
  for (let index = 1; indexes.size < limit; index += 1) {
    indexes.add(Math.round((index * (pageCount - 1)) / (limit - 1)));
  }

  return [...indexes].sort((left, right) => left - right);
}

function readOutputText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.output_text === 'string') {
    return value.output_text;
  }

  if (!Array.isArray(value.output)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (const outputItem of value.output) {
    if (!isRecord(outputItem) || !Array.isArray(outputItem.content)) {
      continue;
    }

    for (const content of outputItem.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string') {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join('').trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
