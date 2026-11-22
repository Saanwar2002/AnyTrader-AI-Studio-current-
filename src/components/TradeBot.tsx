import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Bot, 
  X, 
  Send, 
  Loader2, 
  User, 
  Sparkles, 
  ExternalLink, 
  ShieldCheck, 
  Tag, 
  Star, 
  MapPin, 
  ArrowRight, 
  CheckCircle2, 
  Zap, 
  FileText, 
  Wrench, 
  AlertTriangle,
  RotateCw,
  RotateCcw
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/src/lib/utils";
import { callTradeBotStream, TradeBotHttpError } from "@/src/services/gemini";
import { useAuth } from "./AuthProvider";
import { 
  findGenuineTradeCategories, 
  getHybridTraderRecommendations, 
  TraderRecommendationCard 
} from "@/src/services/aiRecommendationService";
import { categoryRegistry } from "@/src/services/categoryRegistrySync";
import { recordUnmatchedSearch, extractCleanTradeQuery } from "@/src/services/searchOptimizationService";
import { triggerHaptic } from "@/src/lib/capacitor";
import { sanitizeExternalUrl } from "@/src/lib/safeExternalUrl";
import { useDialogA11y } from "@/src/lib/useDialogA11y";
import { toast } from "sonner";

interface GroundingSource {
  title: string;
  url: string;
}

interface Message {
  role: "user" | "model";
  text: string;
  sources?: GroundingSource[];
  suggestedCategories?: string[];
  recommendedTraders?: TraderRecommendationCard[];
  demandGapNotice?: {
    type: "unmatched_category" | "no_traders_found";
    searchTerm: string;
    category?: string;
  };
  quickAction?: {
    type: "post_job" | "emergency_job" | "find_trades";
    category: string;
    title: string;
    description: string;
  };
  errorRetryPrompt?: string;
  isInitialGreeting?: boolean;
}

interface TradeBotProps {
  isOpen: boolean;
  onClose: () => void;
}

function resolveOfficialCategories(rawList: string[], fallback: string[]): string[] {
  if (!rawList || rawList.length === 0) return fallback;
  const resolved: string[] = [];

  for (const raw of rawList) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const canonical = categoryRegistry.resolveCanonicalCategory(trimmed);
    if (canonical && !resolved.includes(canonical)) {
      resolved.push(canonical);
    }
  }

  return resolved.length > 0 ? resolved.slice(0, 3) : fallback;
}

/**
 * Strips complete and partial trailing [MATCHED_CATEGORIES: ...] control tags
 * progressively during live streaming so internal tags never flash in chat bubbles.
 */
export function stripStreamingCategoryTag(text: string): string {
  return String(text || "")
    .replace(/\[MATCHED_CATEGORIES:\s*[^\]]*\]?/gi, "")
    .replace(/\[MATCHED_CATEG[^\]]*$/i, "")
    .trim();
}

/**
 * Distinguishes conversational/account/platform questions from genuine trade-service inquiries
 * so greetings or escrow/billing questions do not produce irrelevant builder cards or false demand gaps.
 */
export function isConversationalOrPlatformQuery(text: string): boolean {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) return true;
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|cheers|ok|okay|bye|goodbye|help|test|yo)[!?. ]*$/i.test(normalized)) {
    return true;
  }
  const platformOnlyPattern = /\b(escrow|stripe|payouts?|refunds?|subscriptions?|login|log in|sign in|sign up|password|accounts?|profiles?|verify my account|disputes?|anytrader fees?|platform fees?|commissions?|how does anytrader work|contact support)\b/i;
  const tradeActionPattern = /\b(repair|fix|install|replace|service|quote|plumber|electrician|boiler|roof|damp|mould|clean|cleaners|builder|painter|locksmith|tyre|van|garden|tree|gas|heating|carpet|cake|handyman|brick|plaster|tile|window|door|drain|leak|rewire|socket)\b/i;
  return platformOnlyPattern.test(normalized) && !tradeActionPattern.test(normalized);
}

function sanitizeSourcesList(sources?: GroundingSource[]): GroundingSource[] {
  if (!Array.isArray(sources)) return [];
  const safe: GroundingSource[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    const validUrl = sanitizeExternalUrl(src?.url);
    if (validUrl && !seen.has(validUrl)) {
      seen.add(validUrl);
      safe.push({
        title: (src?.title || validUrl).trim().slice(0, 140),
        url: validUrl
      });
    }
  }
  return safe.slice(0, 5);
}

export function TradeBot({ isOpen, onClose }: TradeBotProps) {
  const navigate = useNavigate();
  const { user, profile } = useAuth();

  const userRole = profile?.role || "homeowner";
  const userPostcode = profile?.postcode || "";
  const totalCategoryCount = categoryRegistry.getAllCategoryNames().length || 96;

  const buildInitialGreeting = useCallback((firstName?: string): Message => ({
    role: "model",
    isInitialGreeting: true,
    text: `Hello ${firstName || "there"}! I'm AnyTrader AI Copilot.

I'm trained on AnyTrader's UK platform data across ${totalCategoryCount} trade sectors — connecting you with real verified local tradespeople, accurate £ GBP pricing, and safety standards (Gas Safe, Part P, Awaab's Law, FSA).

How can I assist your project today?`,
    suggestedCategories: ["Plumbing", "Electrical", "Painting & Decorating", "Gas & Heating"]
  }), [totalCategoryCount]);

  const [messages, setMessages] = useState<Message[]>(() => [
    buildInitialGreeting(profile?.name ? profile.name.split(" ")[0] : undefined)
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);

  const cancelActiveStream = useCallback(() => {
    if (activeAbortControllerRef.current) {
      activeAbortControllerRef.current.abort();
      activeAbortControllerRef.current = null;
    }
    setIsLoading(false);
    setIsStreaming(false);
  }, []);

  const handleClose = useCallback(() => {
    cancelActiveStream();
    onClose();
  }, [cancelActiveStream, onClose]);

  const dialogRef = useDialogA11y<HTMLDivElement>(isOpen, handleClose);

  // Keep initial greeting personalized once profile finishes loading asynchronously
  useEffect(() => {
    const firstName = profile?.name ? profile.name.split(" ")[0] : undefined;
    if (!firstName) return;
    setMessages(prev => {
      if (prev.length === 0 || !prev[0].isInitialGreeting) return prev;
      const refreshed = buildInitialGreeting(firstName);
      if (prev[0].text === refreshed.text) return prev;
      return [refreshed, ...prev.slice(1)];
    });
  }, [profile?.name, buildInitialGreeting]);

  // Abort any in-flight SSE request if modal closes or unmounts
  useEffect(() => {
    if (!isOpen) {
      cancelActiveStream();
    }
    return () => {
      cancelActiveStream();
    };
  }, [isOpen, cancelActiveStream]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, isStreaming]);

  const handleNewChat = () => {
    triggerHaptic();
    cancelActiveStream();
    setInput("");
    setMessages([buildInitialGreeting(profile?.name ? profile.name.split(" ")[0] : undefined)]);
  };

  const handleSendPrompt = async (promptText: string) => {
    if (!promptText.trim() || isLoading || isStreaming) return;

    const userMessage = promptText.trim();
    setInput("");
    triggerHaptic();

    // Create a fresh AbortController for this request
    cancelActiveStream();
    const controller = new AbortController();
    activeAbortControllerRef.current = controller;

    // 1. Context extraction: Detect GENUINE matching trade categories (no silent Building/Handyman padding)
    const isConversational = isConversationalOrPlatformQuery(userMessage);
    const matchedCats = isConversational ? [] : findGenuineTradeCategories(userMessage, 3);
    const hasInitialCategoryMatch = matchedCats.length > 0;
    const cleanExtractedQuery = extractCleanTradeQuery(userMessage);

    // 2. Query hybrid trader recommendations in parallel ONLY when a genuine trade category matched
    const tradersPromise = hasInitialCategoryMatch
      ? getHybridTraderRecommendations(matchedCats, userPostcode, undefined, userMessage).catch(() => [])
      : Promise.resolve<TraderRecommendationCard[]>([]);

    // 3. User context payload for Gemini (server resolves authoritative role from auth token)
    const userContext = {
      role: userRole,
      postcode: userPostcode || "UK Wide",
      propertySummary: (profile as any)?.boilerModel
        ? `Boiler: ${(profile as any).boilerModel}, EPC: ${(profile as any).epcRating || "C"}`
        : undefined
    };

    // Bounded history excluding the initial greeting and previous error placeholders
    const historyPayload = messages
      .filter(m => !m.isInitialGreeting && !m.errorRetryPrompt && m.text.trim().length > 0)
      .slice(-10)
      .map(m => ({ role: m.role, text: m.text }));

    setMessages(prev => [
      ...prev,
      { role: "user", text: userMessage },
      {
        role: "model",
        text: "",
        suggestedCategories: hasInitialCategoryMatch ? matchedCats : undefined,
      }
    ]);

    setIsLoading(true);
    setIsStreaming(true);

    try {
      let finalAccumulatedText = "";
      let capturedSources: GroundingSource[] = [];
      let streamedCategories: string[] = [];

      const streamResult = await callTradeBotStream(
        userMessage,
        historyPayload,
        userContext,
        {
          onChunk: (_chunk, accumulatedText) => {
            if (controller.signal.aborted) return;
            finalAccumulatedText = accumulatedText;
            setIsLoading(false);
            const cleanDisplay = stripStreamingCategoryTag(accumulatedText);
            setMessages(prev => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (lastIdx >= 0 && updated[lastIdx].role === "model") {
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  text: cleanDisplay
                };
              }
              return updated;
            });
          },
          onSources: (sources) => {
            if (controller.signal.aborted) return;
            const safeSources = sanitizeSourcesList(sources);
            capturedSources = safeSources;
            setMessages(prev => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (lastIdx >= 0 && updated[lastIdx].role === "model") {
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  sources: safeSources
                };
              }
              return updated;
            });
          },
          onCategories: (streamedCats) => {
            if (controller.signal.aborted) return;
            if (streamedCats && streamedCats.length > 0) {
              const resolved = resolveOfficialCategories(streamedCats, matchedCats);
              streamedCategories = resolved;
              setMessages(prev => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                if (lastIdx >= 0 && updated[lastIdx].role === "model") {
                  updated[lastIdx] = {
                    ...updated[lastIdx],
                    suggestedCategories: resolved
                  };
                }
                return updated;
              });
            }
          },
          onError: (err) => {
            console.warn("TradeBot stream callback error:", err);
          }
        },
        controller.signal
      );

      if (controller.signal.aborted) return;

      // Await trader recommendations
      let recommendedTraders = await tradersPromise;
      const rawModelText = finalAccumulatedText || streamResult.text || "";
      const cleanDisplay = stripStreamingCategoryTag(rawModelText);
      const finalSources = sanitizeSourcesList(capturedSources.length > 0 ? capturedSources : streamResult.sources);

      // Extract Gemini-validated categories from streamResult, callback, or text tag
      const catMatch = rawModelText.match(/\[MATCHED_CATEGORIES:\s*([^\]]+)\]/i);
      const geminiRawCats = (streamResult.categories && streamResult.categories.length > 0)
        ? streamResult.categories
        : (streamedCategories.length > 0
            ? streamedCategories
            : (catMatch && catMatch[1] ? catMatch[1].split(",").map(c => c.trim()).filter(Boolean) : []));

      const validatedCategories = geminiRawCats.length > 0
        ? resolveOfficialCategories(geminiRawCats, matchedCats)
        : matchedCats;

      const hasFinalCategoryMatch = validatedCategories.length > 0;

      // If Gemini returned categories that differ from the initial heuristic (or found categories where initial was empty), fetch real matches
      const categoriesDiffer = JSON.stringify(validatedCategories) !== JSON.stringify(matchedCats);
      if (hasFinalCategoryMatch && categoriesDiffer) {
        try {
          const refreshedTraders = await getHybridTraderRecommendations(
            validatedCategories,
            userPostcode,
            undefined,
            userMessage
          );
          recommendedTraders = refreshedTraders || [];
        } catch (e) {
          console.warn("Failed to refresh recommendations with Gemini categories:", e);
        }
      } else if (!hasFinalCategoryMatch) {
        recommendedTraders = [];
      }

      if (controller.signal.aborted) return;

      const finalPrimaryCategory = validatedCategories[0] || "";

      // 4. Telemetry: Record genuine unmatched trade categories or trader supply gaps (skip casual/platform questions)
      let demandGapNotice: Message["demandGapNotice"] = undefined;
      const queryForTelemetry = cleanExtractedQuery || userMessage.trim().slice(0, 40);

      if (!isConversational && queryForTelemetry.length >= 3) {
        if (!hasFinalCategoryMatch && !hasInitialCategoryMatch) {
          demandGapNotice = {
            type: "unmatched_category",
            searchTerm: queryForTelemetry,
          };
          if (user) {
            recordUnmatchedSearch(queryForTelemetry, userPostcode, {
              source: "ai_bot",
              gapType: "unmatched_category",
              category: "",
            });
          }
        } else if (hasFinalCategoryMatch && recommendedTraders.length === 0) {
          demandGapNotice = {
            type: "no_traders_found",
            searchTerm: queryForTelemetry,
            category: finalPrimaryCategory,
          };
          if (user) {
            recordUnmatchedSearch(queryForTelemetry, userPostcode, {
              source: "ai_bot",
              gapType: "no_traders_found",
              category: finalPrimaryCategory,
            });
          }
        }
      }

      // 5. Generate 1-tap quick action spec ONLY when a real trade category matched
      const quickAction: Message["quickAction"] = hasFinalCategoryMatch
        ? {
            type: /\b(emergency|burst|flooding|gas leak|smell gas|power out|no heating)\b/i.test(userMessage)
              ? "emergency_job"
              : "post_job",
            category: finalPrimaryCategory,
            title: userMessage.length > 50 ? `${finalPrimaryCategory} Required` : userMessage,
            description: `Request for ${finalPrimaryCategory} assistance.\n\nAI Diagnostic Summary:\n${cleanDisplay.slice(0, 260)}${cleanDisplay.length > 260 ? "..." : ""}`
          }
        : undefined;

      setMessages(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0 && updated[lastIdx].role === "model") {
          updated[lastIdx] = {
            role: "model",
            text: cleanDisplay,
            sources: finalSources,
            suggestedCategories: hasFinalCategoryMatch ? validatedCategories : undefined,
            recommendedTraders: recommendedTraders.slice(0, 2),
            demandGapNotice,
            quickAction
          };
        }
        return updated;
      });
    } catch (error: any) {
      if (error?.name === "AbortError" || controller.signal.aborted) {
        return;
      }
      console.error("TradeBot Error:", error);

      let friendlyError = "I couldn't reach AnyTrader AI right now. Please tap Retry below or browse verified local trades directly.";
      if (error instanceof TradeBotHttpError) {
        if (error.status === 401) {
          friendlyError = "Please sign in to your AnyTrader account to chat with AnyTrader AI Copilot.";
        } else if (error.status === 402) {
          friendlyError = "AnyTrader AI is temporarily paused while AI service credits are being replenished. You can still browse verified local trades or post your job directly below.";
        } else if (error.status === 403) {
          friendlyError = "AnyTrader AI is temporarily unavailable due to service configuration. Please browse verified local trades directly.";
        } else if (error.status === 429) {
          friendlyError = "You've sent several AI requests in a short window. Please wait a minute and tap Retry.";
        } else if (error.status === 400) {
          friendlyError = error.message || "Your message couldn't be processed. Please shorten or rephrase your question.";
        }
      }

      setMessages(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0 && updated[lastIdx].role === "model") {
          updated[lastIdx] = {
            role: "model",
            text: friendlyError,
            suggestedCategories: ["Plumbing", "Electrical", "Gas & Heating"],
            errorRetryPrompt: userMessage
          };
        }
        return updated;
      });
    } finally {
      if (activeAbortControllerRef.current === controller) {
        activeAbortControllerRef.current = null;
      }
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  const handleCategoryClick = (categoryName: string) => {
    triggerHaptic();
    handleClose();
    navigate(`/find-trades?category=${encodeURIComponent(categoryName)}`);
    toast.success(`Showing top verified trades in ${categoryName}`);
  };

  const handleTraderClick = (uid: string) => {
    triggerHaptic();
    handleClose();
    navigate(`/profile/${uid}`);
  };

  const handleTraderQuoteClick = (uid: string) => {
    triggerHaptic();
    handleClose();
    navigate(`/profile/${uid}`, {
      state: {
        autoOpenQuoteModal: true,
        fromTradeBot: true
      }
    });
  };

  const handleQuickPostJob = (action: NonNullable<Message["quickAction"]>) => {
    triggerHaptic();
    handleClose();
    if (action.type === "emergency_job") {
      const params = new URLSearchParams({
        category: action.category,
        description: action.description,
        source: "tradebot"
      });
      navigate(`/post-emergency-job?${params.toString()}`, {
        state: {
          category: action.category,
          description: action.description
        }
      });
    } else {
      const params = new URLSearchParams({
        category: action.category,
        title: action.title,
        description: action.description,
        source: "tradebot",
        prefilledByAI: "true"
      });
      navigate(`/post-job?${params.toString()}`);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-950/70 backdrop-blur-md animate-in fade-in duration-200"
        onClick={(e) => {
          if (e.target === e.currentTarget) handleClose();
        }}
      >
        <motion.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tradebot-dialog-title"
          tabIndex={-1}
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="bg-white w-full max-w-2xl rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col h-[90dvh] max-h-[720px] sm:h-[700px] border border-black outline-none"
        >
          {/* Top Header */}
          <div className="bg-slate-900 p-4 flex items-center justify-between text-white border-b border-black">
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative w-10 h-10 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-full flex items-center justify-center border border-white/30 shadow-inner shrink-0">
                <Bot className="w-5 h-5 text-white" />
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-400 rounded-full ring-2 ring-slate-900 animate-pulse" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 id="tradebot-dialog-title" className="font-bold text-base leading-tight">Ask AnyTrader AI</h2>
                  <span className="bg-amber-400 text-slate-950 text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider flex items-center gap-1 shadow-2xs">
                    <Sparkles className="w-2.5 h-2.5" /> Fair Match Engine
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[11px] font-medium text-slate-300 truncate">
                    Live UK Pricing • {totalCategoryCount} Trade Categories • Gas Safe & NICEIC
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={handleNewChat}
                className="px-2.5 py-1.5 text-xs font-bold text-slate-200 hover:text-white hover:bg-white/10 rounded-xl transition-colors flex items-center gap-1.5"
                title="Start New Chat"
                aria-label="Start New Chat"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">New Chat</span>
              </button>
              <button 
                type="button"
                onClick={handleClose}
                className="p-2 text-slate-300 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                title="Close AI Assistant"
                aria-label="Close AI Assistant"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Messages Feed */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5 bg-slate-50">
            {messages.map((msg, i) => (
              <div 
                key={i}
                className={cn(
                  "flex gap-3 max-w-[92%]",
                  msg.role === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
                )}
              >
                {/* Avatar Icon */}
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center shrink-0 border border-black shadow-2xs",
                  msg.role === "user" ? "bg-blue-600 text-white" : "bg-white text-slate-800"
                )}>
                  {msg.role === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4 text-blue-600" />}
                </div>

                <div className="space-y-3 flex-1 min-w-0">
                  {/* Message Bubble */}
                  {msg.text ? (
                    <div className={cn(
                      "p-4 rounded-2xl text-sm leading-relaxed whitespace-pre-line border border-black shadow-xs",
                      msg.role === "user" 
                        ? "bg-blue-600 text-white rounded-tr-none" 
                        : "bg-white text-black rounded-tl-none font-medium"
                    )}>
                      {msg.text}
                      {isStreaming && i === messages.length - 1 && msg.role === "model" && (
                        <span className="inline-block w-1.5 h-4 bg-blue-600 animate-pulse ml-1.5 align-middle rounded-xs shadow-2xs" />
                      )}
                      {msg.errorRetryPrompt && !isStreaming && !isLoading && (
                        <div className="mt-3 pt-2.5 border-t border-slate-200 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleSendPrompt(msg.errorRetryPrompt!)}
                            className="inline-flex items-center gap-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold px-3 py-1.5 rounded-xl border border-black transition-colors active:scale-95"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>Retry Question</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    msg.role === "model" && isStreaming && (
                      <div className="p-3.5 rounded-2xl bg-white border border-black rounded-tl-none shadow-xs flex items-center gap-2.5 text-xs text-black">
                        <Loader2 className="w-4 h-4 animate-spin text-blue-600 shrink-0" />
                        <span className="font-semibold animate-pulse">Streaming live response from AnyTrader AI...</span>
                      </div>
                    )
                  )}

                  {/* Grounding Web Citations (Sanitized HTTPS URLs Only) */}
                  {msg.role === "model" && msg.sources && msg.sources.length > 0 && (
                    <div className="bg-amber-50 border border-black rounded-xl p-3 space-y-1.5 shadow-2xs">
                      <div className="text-[11px] font-bold text-black flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-amber-700" />
                        <span>Verified Live UK Sources:</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.sources.map((source, sIdx) => {
                          const safeUrl = sanitizeExternalUrl(source.url);
                          if (!safeUrl) return null;
                          return (
                            <a
                              key={sIdx}
                              href={safeUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 bg-white border border-black text-black hover:bg-amber-100/60 text-[11px] font-medium px-2 py-0.5 rounded-md transition-colors shadow-2xs"
                            >
                              <span className="truncate max-w-[220px]">{source.title}</span>
                              <ExternalLink className="w-3 h-3 text-slate-600 shrink-0" />
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Suggested Category Chips */}
                  {msg.role === "model" && msg.suggestedCategories && msg.suggestedCategories.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-black flex items-center gap-1">
                        <Tag className="w-3 h-3 text-blue-600" /> Suggested Trade Categories:
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.suggestedCategories.map((cat, catIdx) => (
                          <button
                            key={catIdx}
                            type="button"
                            onClick={() => handleCategoryClick(cat)}
                            className="inline-flex items-center gap-1.5 bg-white border border-black hover:bg-blue-50 text-black text-xs font-bold px-3 py-1.5 rounded-full transition-all shadow-2xs group active:scale-95"
                          >
                            <span>{cat}</span>
                            <ArrowRight className="w-3 h-3 text-blue-600 group-hover:translate-x-0.5 transition-transform" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Demand Gap Notification for Homeowner (Unmatched Category or 0 Local Traders) */}
                  {msg.role === "model" && msg.demandGapNotice && (
                    <div className="bg-amber-50/90 border border-black rounded-2xl p-3.5 space-y-1.5 shadow-2xs">
                      <div className="flex items-center gap-2 text-xs font-bold text-black">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                        <span>
                          {msg.demandGapNotice.type === "no_traders_found"
                            ? `No Verified Local Specialists Yet for "${msg.demandGapNotice.category || msg.demandGapNotice.searchTerm}"`
                            : `New Specialty Logged: "${msg.demandGapNotice.searchTerm}"`}
                        </span>
                      </div>
                      <p className="text-[11px] text-black leading-relaxed font-medium">
                        {msg.demandGapNotice.type === "no_traders_found"
                          ? "We've logged this demand so nearby verified trades in this category can be alerted. You can still post your job below to collect quotes directly."
                          : `We've logged "${msg.demandGapNotice.searchTerm}" in AnyTrader's demand queue so our team can index this specialty.`}
                      </p>
                    </div>
                  )}

                  {/* Interactive Trader Recommendation Cards (Real Verified Profiles Only) */}
                  {msg.role === "model" && msg.recommendedTraders && msg.recommendedTraders.length > 0 && (
                    <div className="space-y-2 pt-1">
                      <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-black">
                        <span className="flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Matching Verified Local Traders
                        </span>
                        <span className="text-slate-600 font-normal text-[10px] lowercase">
                          fair rotation active
                        </span>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        {msg.recommendedTraders.map((trader) => (
                          <div
                            key={trader.uid}
                            className={cn(
                              "bg-white border rounded-2xl p-3.5 shadow-sm hover:shadow-md transition-all flex flex-col justify-between gap-3 text-left relative overflow-hidden",
                              trader.isSponsored ? "border-amber-500 ring-1 ring-amber-400/40 bg-amber-50/20" : "border-black"
                            )}
                          >
                            {/* Slot Badge */}
                            <div className="flex items-center justify-between gap-2">
                              {trader.isSponsored ? (
                                <span className="bg-amber-400 text-black text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider flex items-center gap-1 border border-black/20 shadow-2xs">
                                  <Zap className="w-3 h-3 fill-black" /> Featured Pro
                                </span>
                              ) : trader.isNewcomerBoost ? (
                                <span className="bg-emerald-100 text-black border border-emerald-400 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase flex items-center gap-1">
                                  <Sparkles className="w-3 h-3 text-emerald-700" /> Newcomer Boost
                                </span>
                              ) : (
                                <span className="bg-blue-50 text-black border border-blue-300 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase flex items-center gap-1">
                                  <RotateCw className="w-2.5 h-2.5 text-blue-600" /> Fair Match
                                </span>
                              )}

                              <div className="flex items-center gap-1 text-xs font-bold text-black">
                                {trader.reviewsCount > 0 && trader.rating > 0 ? (
                                  <>
                                    <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                                    <span>{trader.rating.toFixed(1)}</span>
                                    <span className="text-slate-600 font-normal text-[11px]">({trader.reviewsCount})</span>
                                  </>
                                ) : (
                                  <span className="text-[11px] font-semibold text-slate-700">New Trader</span>
                                )}
                              </div>
                            </div>

                            {/* Trader Info */}
                            <div className="flex items-center gap-3">
                              <img
                                src={trader.avatarUrl}
                                alt={trader.name}
                                className="w-11 h-11 rounded-full object-cover border border-black shrink-0"
                              />
                              <div className="min-w-0">
                                <h4 className="font-bold text-sm text-black truncate leading-tight">
                                  {trader.name}
                                </h4>
                                <p className="text-xs text-black/80 truncate font-medium">
                                  {trader.businessName || trader.category}
                                </p>
                                <div className="flex items-center flex-wrap gap-1.5 text-[11px] text-black/75 mt-0.5">
                                  <MapPin className="w-3 h-3 text-slate-600 shrink-0" />
                                  <span>
                                    {typeof trader.distanceMiles === "number"
                                      ? `${trader.distanceMiles} mi away`
                                      : (trader.postcode || "UK Verified")}
                                  </span>
                                  {trader.isGasSafe && <span className="text-amber-700 font-bold">• Gas Safe</span>}
                                  {trader.isNiceic && <span className="text-blue-700 font-bold">• NICEIC</span>}
                                </div>
                              </div>
                            </div>

                            {/* Action Buttons */}
                            <div className="flex items-center gap-2 pt-1 border-t border-slate-200">
                              <button
                                type="button"
                                onClick={() => handleTraderClick(trader.uid)}
                                className="flex-1 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs py-2 px-3 rounded-xl border border-black transition-colors flex items-center justify-center gap-1.5 shadow-2xs active:scale-95"
                              >
                                <span>View Profile</span>
                                <ArrowRight className="w-3 h-3 text-amber-400" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleTraderQuoteClick(trader.uid)}
                                className="bg-amber-400 hover:bg-amber-500 text-black font-black text-xs py-2 px-3 rounded-xl border border-black transition-colors shadow-2xs active:scale-95"
                                title="Request Direct Quote"
                              >
                                Quote
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 1-Tap Quick Action CTA (Post Job / Emergency Job with AI Specs) */}
                  {msg.role === "model" && msg.quickAction && (
                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-black rounded-2xl p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-sm">
                      <div className="space-y-0.5">
                        <div className="text-xs font-bold text-black flex items-center gap-1.5">
                          <FileText className="w-3.5 h-3.5 text-blue-700" />
                          <span>
                            {msg.quickAction.type === "emergency_job"
                              ? "Urgent Issue Detected — Dispatch Local Help"
                              : "1-Tap Action: Ready to request quotes?"}
                          </span>
                        </div>
                        <p className="text-[11px] text-black/80 font-medium">
                          Pre-filled with your {msg.quickAction.category} category and AI diagnostic summary.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleQuickPostJob(msg.quickAction!)}
                        className={cn(
                          "w-full sm:w-auto text-white text-xs font-bold py-2.5 px-4 rounded-xl border border-black flex items-center justify-center gap-2 shadow-2xs transition-all shrink-0 active:scale-95",
                          msg.quickAction.type === "emergency_job"
                            ? "bg-red-600 hover:bg-red-700"
                            : "bg-blue-600 hover:bg-blue-700"
                        )}
                      >
                        <Zap className="w-3.5 h-3.5 text-amber-300" />
                        <span>
                          {msg.quickAction.type === "emergency_job"
                            ? "Post Emergency Job"
                            : "Post Job with AI Specs"}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Messages Feed End Ref */}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Prompt Carousel Pills */}
          <div className="bg-slate-100 px-4 py-2.5 border-t border-black flex gap-2 overflow-x-auto scrollbar-none">
            <button
              type="button"
              disabled={isLoading || isStreaming}
              onClick={() => handleSendPrompt("My boiler is losing pressure and making banging sounds. What causes this and what are typical UK repair costs?")}
              className="shrink-0 bg-white border border-black hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed text-black text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-2xs active:scale-95"
            >
              <Wrench className="w-3 h-3 text-blue-600" /> Boiler Pressure & Banging Faults
            </button>
            <button
              type="button"
              disabled={isLoading || isStreaming}
              onClick={() => handleSendPrompt("What are the UK Part P building regulations for installing new downlights and sockets in a kitchen?")}
              className="shrink-0 bg-white border border-black hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed text-black text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-2xs active:scale-95"
            >
              <Zap className="w-3 h-3 text-amber-500" /> Part P Kitchen Electrical Rules
            </button>
            <button
              type="button"
              disabled={isLoading || isStreaming}
              onClick={() => handleSendPrompt("What are standard UK rates for end-of-tenancy deep cleaning and carpet steam washing?")}
              className="shrink-0 bg-white border border-black hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed text-black text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-2xs active:scale-95"
            >
              <ShieldCheck className="w-3 h-3 text-emerald-600" /> End of Tenancy Cleaning Rates
            </button>
            <button
              type="button"
              disabled={isLoading || isStreaming}
              onClick={() => handleSendPrompt("How much does a 3-tier custom wedding cake cost in the UK and what food allergen laws apply?")}
              className="shrink-0 bg-white border border-black hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed text-black text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-2xs active:scale-95"
            >
              🎂 Wedding Cake Pricing & Natasha's Law
            </button>
          </div>

          {/* User Input Bar */}
          <div className="p-3 sm:p-4 bg-white border-t border-black shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="relative">
              <label htmlFor="tradebot-chat-input" className="sr-only">
                Ask AnyTrader AI about prices, regulations, or describe a job
              </label>
              <input 
                id="tradebot-chat-input"
                type="text"
                maxLength={1500}
                placeholder="Ask about prices, regulations, or describe a job to match trades..."
                className="w-full pl-4 pr-12 py-3.5 bg-slate-100 border border-black/20 rounded-2xl focus:ring-2 focus:ring-blue-600/30 focus:bg-white transition-all text-sm font-medium text-black placeholder:text-slate-500"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSendPrompt(input)}
              />
              <button 
                type="button"
                onClick={() => handleSendPrompt(input)}
                disabled={!input.trim() || isLoading || isStreaming}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm active:scale-95"
                title="Send Message"
                aria-label="Send Message"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            
            <div className="mt-2.5 flex items-center justify-between text-[10px] text-black/75 font-medium px-1">
              <div className="flex items-center gap-1 text-black">
                <Sparkles className="w-3 h-3 text-amber-500" />
                <span>Trained on AnyTrader UK Database & Standards</span>
              </div>
              <div className="text-slate-600">
                Fairness Rotation Engine Active
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
