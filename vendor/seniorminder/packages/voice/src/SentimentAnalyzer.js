// packages/voice/src/SentimentAnalyzer.js
//
// LLM-based sentiment analysis for patient speech transcripts.
//
// Extracted from ParallelRecorder.analyzeSentiment() so the logic
// lives in the voice package and is used by ParallelRecorder (LiveAvatar path).
//
// Returns: { polarity_score, subjectivity_score, magnitude, dominant_emotion }
// Returns: null if transcript is too short, llmService unavailable, or LLM fails.

import { AppLogger } from '@seniorminder/logger';

const MODULE_NAME = 'SentimentAnalyzer';

// Minimum word count before sentiment analysis is meaningful
const MIN_WORD_COUNT = 4;

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

            AppLogger.debug(MODULE_NAME, METHOD_NAME,
                `Sentiment: polarity=${parsed.polarity_score}, emotion=${parsed.dominant_emotion}`);

            return parsed;

        } catch (err) {
            AppLogger.warn(MODULE_NAME, METHOD_NAME,
                `Sentiment analysis failed: ${err.message}`);
            return null;
        }
    }
}
