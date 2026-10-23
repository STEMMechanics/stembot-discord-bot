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
const MAX_OUTPUT_TOKENS = 512;
const FALLBACK_REASONING_EFFORT = 'low';
const NUMBER_RECOGNITION_PROMPT = [
  'Identify the single positive integer explicitly displayed or clearly asserted by the image frames.',
  'Read Arabic digits, spelled-out cardinal number words, stylized text, and unambiguous phrases that state a number.',
  'For a correction such as "not one, but two!", return 2: choose the affirmed value, not the negated value.',
  'Also recognize a clearly presented hand gesture representing one number, such as a person intentionally holding up two fingers for 2.',
  'Count raised fingers only when the gesture is clearly the intended answer; do not count incidental fingers, people, or unrelated objects.',
  'Treat all frames as one image. If frames conflict, or multiple numbers are shown without a clear intended value, return null.',
  'Do not count objects, solve arithmetic, infer a missing or next number, use the game state, or guess from context.',
  'If no single positive integer is clearly readable or asserted, return null.',
].join(' ');

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
    let body = await this.requestRecognition(frames, this.options.reasoningEffort);
    const diagnostics = summarizeResponse(body, readOutputText(body));
    if (
      diagnostics.incompleteReason === 'max_output_tokens' &&
      this.options.reasoningEffort !== FALLBACK_REASONING_EFFORT
    ) {
      this.options.logger.warn(
        {
          ...diagnostics,
          configuredReasoningEffort: this.options.reasoningEffort,
          retryReasoningEffort: FALLBACK_REASONING_EFFORT,
        },
        'OpenAI number recognition exhausted its token budget; retrying with low reasoning effort',
      );
      body = await this.requestRecognition(frames, FALLBACK_REASONING_EFFORT);
    }

    return parseRecognitionResponse(body, this.options.logger);
  }

  private async requestRecognition(
    frames: readonly Buffer[],
    reasoningEffort: string,
  ): Promise<unknown> {
    const response = await this.fetchImplementation('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(this.options.timeoutMs),
      body: JSON.stringify({
        model: this.options.model,
        reasoning: { effort: reasoningEffort },
        store: false,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: NUMBER_RECOGNITION_PROMPT,
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

    return response.json();
  }
}

function parseRecognitionResponse(body: unknown, logger: AppLogger): number | null {
  const outputText = readOutputText(body);
  if (!outputText) {
    const diagnostics = summarizeResponse(body, outputText);
    logger.warn(diagnostics, 'OpenAI number recognition returned no structured output');
    throw new Error(
      `OpenAI number recognition returned no structured output (${formatDiagnostics(diagnostics)})`,
    );
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

interface ResponseDiagnostics {
  responseId: string | null;
  status: string | null;
  incompleteReason: string | null;
  outputCount: number;
  outputTypes: string[];
  outputTextLength: number;
  refusal: boolean;
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

function summarizeResponse(value: unknown, outputText: string | undefined): ResponseDiagnostics {
  if (!isRecord(value)) {
    return {
      responseId: null,
      status: null,
      incompleteReason: null,
      outputCount: 0,
      outputTypes: [],
      outputTextLength: outputText?.length ?? 0,
      refusal: false,
    };
  }

  const output = Array.isArray(value.output) ? value.output : [];
  const outputTypes = new Set<string>();
  let refusal = false;
  for (const outputItem of output) {
    if (!isRecord(outputItem)) {
      continue;
    }

    if (typeof outputItem.type === 'string') {
      outputTypes.add(outputItem.type);
    }

    if (!Array.isArray(outputItem.content)) {
      continue;
    }

    for (const content of outputItem.content) {
      if (!isRecord(content)) {
        continue;
      }

      if (typeof content.type === 'string') {
        outputTypes.add(content.type);
      }
      if (content.type === 'refusal' || typeof content.refusal === 'string') {
        refusal = true;
      }
    }
  }

  const incompleteDetails = isRecord(value.incomplete_details)
    ? value.incomplete_details
    : undefined;

  return {
    responseId: typeof value.id === 'string' ? value.id : null,
    status: typeof value.status === 'string' ? value.status : null,
    incompleteReason:
      incompleteDetails && typeof incompleteDetails.reason === 'string'
        ? incompleteDetails.reason
        : null,
    outputCount: output.length,
    outputTypes: [...outputTypes].sort(),
    outputTextLength: outputText?.length ?? 0,
    refusal,
  };
}

function formatDiagnostics(diagnostics: ResponseDiagnostics): string {
  return [
    `status=${diagnostics.status ?? 'unknown'}`,
    `reason=${diagnostics.incompleteReason ?? 'none'}`,
    `outputCount=${diagnostics.outputCount}`,
    `outputTypes=${diagnostics.outputTypes.join('|') || 'none'}`,
    `refusal=${diagnostics.refusal}`,
  ].join(', ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
