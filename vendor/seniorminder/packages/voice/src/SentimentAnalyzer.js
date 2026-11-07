// packages/voice/src/SentimentAnalyzer.js
//
// LLM-based sentiment analysis for patient speech transcripts.
//
// Extracted from ParallelRecorder.analyzeSentiment() so the logic
// lives in the voice package and is used by ParallelRecorder (LiveAvatar path).
//
// Returns: { polarity_score, subjectivity_score, magnitude, dominant_emotion }
// Returns: null if transcript is too short, llmService unavailable, or LLM fails,
//          or the model's answer is not all four fields inside the prompt's own ranges.

import { AppLogger } from '@seniorminder/logger';

const MODULE_NAME = 'SentimentAnalyzer';

// Minimum word count before sentiment analysis is meaningful
const MIN_WORD_COUNT = 4;

// The five labels the prompt offers. Anything else is not an answer to the question asked.
export const SENTIMENT_EMOTIONS = ['joy', 'sadness', 'anger', 'fear', 'neutral'];

const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Why a parsed model answer is not a sentiment score, or null when it is one.
 *
 * A SCORE IS ALL FOUR FIELDS, EACH INSIDE THE PROMPT'S OWN RANGE. The model is asked for exactly that
 * shape, and anything else used to pass straight through: {} and [] came back as "scores", and "0", 4 and
 * "boredom" went to VoiceMetricsRecorder, which stored whatever of them it could, field by field. A
 * half-answer stored as Sentiment rows reads downstream as a real reading of his mood; no rows is the true
 * record of a failed call. A genuine all-zero "neutral" is inside every range and is a score.
 *
 * @param {*} parsed - JSON.parse of the model's reply.
 * @returns {string|null}
 */
export function sentimentAnswerProblem(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const what = Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed;
        return `the answer is ${what}, not an object`;
    }
    const { polarity_score, subjectivity_score, magnitude, dominant_emotion } = parsed;
    if (!inRange(polarity_score, -1, 1)) return `polarity_score ${JSON.stringify(polarity_score)} is not a number from -1 to 1`;
    if (!inRange(subjectivity_score, 0, 1)) return `subjectivity_score ${JSON.stringify(subjectivity_score)} is not a number from 0 to 1`;
    if (!inRange(magnitude, 0, 1)) return `magnitude ${JSON.stringify(magnitude)} is not a number from 0 to 1`;
    if (!SENTIMENT_EMOTIONS.includes(dominant_emotion)) {
        return `dominant_emotion ${JSON.stringify(dominant_emotion)} is not one of ${SENTIMENT_EMOTIONS.join(', ')}`;
    }
    return null;
}

export class SentimentAnalyzer {
    /**
     * @param {object} options
     * @param {object} options.llmService - LLM service with a .complete(prompt, opts) method
     */
    constructor({ llmService }) {
        this.llmService = llmService;
    }

    /**
     * Analyze sentiment of a patient transcript.
     *
     * @param {string|null} transcript
     * @returns {Promise<{polarity_score: number, subjectivity_score: number, magnitude: number, dominant_emotion: string}|null>}
     */
    async analyze(transcript) {
        const METHOD_NAME = 'analyze';

        if (!transcript || transcript.trim().split(/\s+/).length < MIN_WORD_COUNT) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME,
                'Transcript too short for sentiment analysis, skipping');
            return null;
        }

        if (!this.llmService) {
            AppLogger.debug(MODULE_NAME, METHOD_NAME,
                'No LLM service available, skipping sentiment');
            return null;
        }

        try {
            const prompt =
                'Analyze the sentiment of this patient statement. ' +
                'Respond ONLY with valid JSON, no markdown, no explanation:\n' +
                '{"polarity_score": <number -1.0 to 1.0>, ' +
                '"subjectivity_score": <number 0.0 to 1.0>, ' +
                '"magnitude": <number 0.0 to 1.0>, ' +
                '"dominant_emotion": <"joy"|"sadness"|"anger"|"fear"|"neutral">}\n\n' +
                `Statement: "${transcript.trim()}"`;

            const raw = await this.llmService.generateCompletion(prompt, { maxTokens: 100 });
            const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

            const problem = sentimentAnswerProblem(parsed);
            if (problem) {
                AppLogger.warn(MODULE_NAME, METHOD_NAME,
                    `Sentiment answer rejected, nothing stored: ${problem}`);
                return null;
            }

            AppLogger.debug(MODULE_NAME, METHOD_NAME,
                `Sentiment: polarity=${parsed.polarity_score}, emotion=${parsed.dominant_emotion}`);

            const { polarity_score, subjectivity_score, magnitude, dominant_emotion } = parsed;
            return { polarity_score, subjectivity_score, magnitude, dominant_emotion };

        } catch (err) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME,
                `Sentiment analysis failed: ${err.message}`);
            return null;
        }
    }
}
