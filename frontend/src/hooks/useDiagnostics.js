import { useCallback, useEffect, useMemo, useRef } from 'react';

const MAX_EVENTS = 200;
const MAX_STATS_SAMPLES = 32;
const DEFAULT_FLUSH_DELAY_MS = 4000;

function makeScopeId(prefix = 'diag') {
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now()}-${random}`;
}

function pushCapped(list, value, limit) {
    list.push(value);
    if (list.length > limit) {
        list.splice(0, list.length - limit);
    }
}

function summarizeStats(stats, pc, peerId, peerType) {
    const data = {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        iceGatheringState: pc.iceGatheringState,
        signalingState: pc.signalingState
    };

    stats.forEach((report) => {
        if (report.type === 'candidate-pair' && (report.selected || report.nominated || report.state === 'succeeded')) {
            data.selectedCandidatePair = {
                state: report.state,
                currentRoundTripTime: report.currentRoundTripTime,
                availableOutgoingBitrate: report.availableOutgoingBitrate,
                availableIncomingBitrate: report.availableIncomingBitrate,
                bytesSent: report.bytesSent,
                bytesReceived: report.bytesReceived
            };
        }

        if (report.type === 'outbound-rtp' && !report.isRemote) {
            data.outbound = data.outbound || {};
            data.outbound[report.kind || 'unknown'] = {
                packetsSent: report.packetsSent,
                bytesSent: report.bytesSent,
                framesEncoded: report.framesEncoded,
                frameWidth: report.frameWidth,
                frameHeight: report.frameHeight,
                qualityLimitationReason: report.qualityLimitationReason
            };
        }

        if (report.type === 'inbound-rtp' && !report.isRemote) {
            data.inbound = data.inbound || {};
            data.inbound[report.kind || 'unknown'] = {
                packetsReceived: report.packetsReceived,
                packetsLost: report.packetsLost,
                bytesReceived: report.bytesReceived,
                jitter: report.jitter,
                framesDecoded: report.framesDecoded,
                frameWidth: report.frameWidth,
                frameHeight: report.frameHeight
            };
        }

        if (report.type === 'data-channel') {
            data.dataChannel = {
                state: report.state,
                label: report.label,
                messagesSent: report.messagesSent,
                messagesReceived: report.messagesReceived,
                bytesSent: report.bytesSent,
                bytesReceived: report.bytesReceived
            };
        }
    });

    return {
        at: Date.now(),
        remoteId: peerId || '',
        peerType: peerType || 'webrtc',
        data
    };
}

function createScope(scopeType = 'app', metadata = {}) {
    return {
        id: makeScopeId(scopeType),
        scopeType,
        metadata,
        startedAt: Date.now(),
        events: [],
        statsSamples: [],
        issueKeys: new Set(),
        pendingReason: ''
    };
}

function printDiagnosticsReport(report) {
    const title = `[patrick-im diagnostics] ${report.reason || 'report'} (${report.callId})`;

    if (typeof console.groupCollapsed === 'function') {
        console.groupCollapsed(title);
        console.log('context:', report.context);
        console.log('issueKeys:', report.issueKeys);
        console.log('events:', report.events);
        console.log('statsSamples:', report.statsSamples);
        if (report.extra && Object.keys(report.extra).length > 0) {
            console.log('extra:', report.extra);
        }
        console.groupEnd();
        return;
    }

    console.warn(title, report);
}

export function useDiagnostics({ getContext }) {
    const scopeRef = useRef(null);
    const flushTimerRef = useRef(null);

    const clearFlushTimer = useCallback(() => {
        if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
        }
    }, []);

    const resetScope = useCallback(() => {
        scopeRef.current = null;
        clearFlushTimer();
    }, [clearFlushTimer]);

    const ensureScope = useCallback((scopeType = 'app', metadata = {}) => {
        if (!scopeRef.current) {
            scopeRef.current = createScope(scopeType, metadata);
        } else if (metadata && Object.keys(metadata).length > 0) {
            scopeRef.current.metadata = {
                ...scopeRef.current.metadata,
                ...metadata
            };
        }
        return scopeRef.current;
    }, []);

    const buildReport = useCallback((reason, extra = {}) => {
        const scope = scopeRef.current;
        if (!scope) {
            return null;
        }

        return {
            callId: scope.id,
            startedAt: scope.startedAt,
            endedAt: Date.now(),
            reason,
            context: {
                ...(getContext ? getContext() : {}),
                scopeType: scope.scopeType,
                ...scope.metadata,
                ...(extra.context || {})
            },
            issueKeys: Array.from(scope.issueKeys),
            events: scope.events,
            statsSamples: scope.statsSamples,
            extra: extra.extra || {}
        };
    }, [getContext]);

    const flush = useCallback(async (reason = 'manual', options = {}) => {
        clearFlushTimer();

        const scope = scopeRef.current;
        if (!scope) {
            return false;
        }

        if (
            scope.events.length === 0 &&
            scope.statsSamples.length === 0 &&
            scope.issueKeys.size === 0
        ) {
            return false;
        }

        const report = buildReport(reason, options);
        if (!report) {
            return false;
        }

        printDiagnosticsReport(report);
        resetScope();
        return true;
    }, [buildReport, clearFlushTimer, resetScope]);

    const flushIfIssues = useCallback(async (reason = 'issue_flush', options = {}) => {
        if (!scopeRef.current || scopeRef.current.issueKeys.size === 0) {
            return false;
        }
        return flush(reason, options);
    }, [flush]);

    const scheduleFlush = useCallback((reason = 'scheduled', delayMs = DEFAULT_FLUSH_DELAY_MS) => {
        const scope = scopeRef.current;
        if (!scope) {
            return;
        }

        scope.pendingReason = reason;
        clearFlushTimer();
        flushTimerRef.current = setTimeout(() => {
            const pendingReason = scopeRef.current?.pendingReason || reason;
            void flush(pendingReason, { extra: { trigger: 'scheduled' } });
        }, delayMs);
    }, [clearFlushTimer, flush]);

    const recordEvent = useCallback((kind, data = {}, options = {}) => {
        const scope = ensureScope(options.scopeType || 'app', options.context || {});
        pushCapped(scope.events, {
            at: Date.now(),
            kind,
            level: options.level || 'info',
            data
        }, MAX_EVENTS);

        if (options.flush === 'immediate') {
            void flush(options.reason || kind, options.flushOptions || {});
        } else if (options.flush) {
            scheduleFlush(options.reason || kind, options.delayMs);
        }

        return scope.id;
    }, [ensureScope, flush, scheduleFlush]);

    const reportIssue = useCallback((issueKey, data = {}, options = {}) => {
        const scope = ensureScope(options.scopeType || 'app', options.context || {});
        scope.issueKeys.add(issueKey);
        pushCapped(scope.events, {
            at: Date.now(),
            kind: options.kind || issueKey,
            level: options.level || 'warn',
            data
        }, MAX_EVENTS);

        console.warn(`[patrick-im diagnostics] ${issueKey}`, data);

        if (options.flush === 'immediate') {
            void flush(options.reason || issueKey, options.flushOptions || {});
        } else {
            scheduleFlush(options.reason || issueKey, options.delayMs);
        }

        return scope.id;
    }, [ensureScope, flush, scheduleFlush]);

    const capturePeerStats = useCallback(async ({
        peerId,
        pc,
        peerType = 'webrtc',
        scopeType = 'app',
        context = {}
    }) => {
        if (!pc || typeof pc.getStats !== 'function') {
            return false;
        }

        const scope = ensureScope(scopeType, context);

        try {
            const stats = await pc.getStats();
            pushCapped(scope.statsSamples, summarizeStats(stats, pc, peerId, peerType), MAX_STATS_SAMPLES);
            return true;
        } catch (error) {
            pushCapped(scope.events, {
                at: Date.now(),
                kind: 'stats_capture_failed',
                level: 'warn',
                data: {
                    peerId,
                    peerType,
                    message: error?.message || 'unknown'
                }
            }, MAX_EVENTS);
            return false;
        }
    }, [ensureScope]);

    const retryPendingReports = useCallback(async () => 0, []);

    useEffect(() => () => {
        if (scopeRef.current?.issueKeys.size) {
            void flush('page_unload');
        } else {
            clearFlushTimer();
        }
    }, [clearFlushTimer, flush]);

    return useMemo(() => ({
        recordEvent,
        reportIssue,
        capturePeerStats,
        flush,
        flushIfIssues,
        retryPendingReports
    }), [recordEvent, reportIssue, capturePeerStats, flush, flushIfIssues, retryPendingReports]);
}
