import { useCallback, useEffect, useMemo, useRef } from 'react';
import { fetchSession } from '../constants/config';

const STORAGE_KEY = 'patrick-im-pending-diagnostics';
const MAX_EVENTS = 200;
const MAX_STATS_SAMPLES = 32;
const MAX_PENDING_REPORTS = 5;
const DEFAULT_FLUSH_DELAY_MS = 4000;
const STALE_TRANSIENT_REPORT_MAX_AGE_MS = 2 * 60 * 1000;
const TRANSIENT_REPORT_REASONS = new Set(['ws_closed', 'ws_closed_repeatedly']);
let sessionRefreshPromise = null;

async function refreshAnonymousSession() {
    if (!sessionRefreshPromise) {
        sessionRefreshPromise = fetchSession().finally(() => {
            sessionRefreshPromise = null;
        });
    }

    return sessionRefreshPromise;
}

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

function readPendingReports() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writePendingReports(reports) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(reports.slice(-MAX_PENDING_REPORTS)));
    } catch {
        // 忽略本地存储失败，避免影响主流程
    }
}

function shouldDropPendingReport(report) {
    if (!report || typeof report !== 'object') {
        return true;
    }

    if (!TRANSIENT_REPORT_REASONS.has(report.reason)) {
        return false;
    }

    const endedAt = typeof report.endedAt === 'number' ? report.endedAt : 0;
    if (!endedAt) {
        return false;
    }

    return Date.now() - endedAt > STALE_TRANSIENT_REPORT_MAX_AGE_MS;
}

async function postDiagnostics(report, keepalive = false, allowSessionRefresh = true) {
    const response = await fetch('/api/diagnostics', {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(report),
        keepalive
    });

    if (response.status === 401 && allowSessionRefresh && !keepalive) {
        await refreshAnonymousSession();
        return postDiagnostics(report, keepalive, false);
    }

    if (!response.ok) {
        throw new Error(`Diagnostics upload failed: ${response.status}`);
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
        uploadCount: 0,
        events: [],
        statsSamples: [],
        issueKeys: new Set(),
        pendingReason: ''
    };
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

    const stashPendingReport = useCallback((report) => {
        const pending = readPendingReports();
        pending.push(report);
        writePendingReports(pending);
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
            uploadCount: scope.uploadCount + 1,
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

        try {
            await postDiagnostics(report, options.keepalive === true);
            resetScope();
            return true;
        } catch (error) {
            console.warn('Failed to upload diagnostics report:', error);
            scope.uploadCount += 1;
            stashPendingReport(report);
            resetScope();
            return false;
        }
    }, [buildReport, clearFlushTimer, resetScope, stashPendingReport]);

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
            flush(pendingReason, { extra: { trigger: 'scheduled' } });
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

    const retryPendingReports = useCallback(async () => {
        const pending = readPendingReports();
        if (pending.length === 0) {
            return 0;
        }

        const remaining = [];
        let uploadedCount = 0;

        for (const report of pending) {
            if (shouldDropPendingReport(report)) {
                continue;
            }

            try {
                await postDiagnostics(report);
                uploadedCount += 1;
            } catch (error) {
                console.warn('Failed to replay pending diagnostics report:', error);
                remaining.push(report);
            }
        }

        writePendingReports(remaining);
        return uploadedCount;
    }, []);

    useEffect(() => () => {
        if (scopeRef.current?.issueKeys.size) {
            void flush('page_unload', { keepalive: true });
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
