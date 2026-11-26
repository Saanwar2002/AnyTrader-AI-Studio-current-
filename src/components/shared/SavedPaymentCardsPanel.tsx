import React from "react";
import { CreditCard, Lock, Shield, ShieldCheck, Plus, Trash2, Loader2, Star, Check } from "lucide-react";

export interface SavedCardItem {
  id: string;
  brand?: string;
  last4: string;
  expMonth?: number | string | null;
  expYear?: number | string | null;
  isDefault?: boolean;
}

interface SavedPaymentCardsPanelProps {
  savedCards: SavedCardItem[];
  isAddingCard?: boolean;
  busyCardId?: string | null;
  busyAction?: "default" | "delete" | null;
  onAddCard: () => void;
  onSetDefault: (paymentMethodId: string) => void;
  onDeleteCard: (paymentMethodId: string) => void;
  title?: string;
  subtitle?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  showSecurityFooter?: boolean;
}

function formatExpiry(expMonth?: number | string | null, expYear?: number | string | null): string {
  const monthStr = expMonth !== undefined && expMonth !== null && String(expMonth).trim() !== ""
    ? String(expMonth).padStart(2, "0")
    : "--";
  const yearStr = expYear !== undefined && expYear !== null && String(expYear).trim() !== ""
    ? String(expYear)
    : "----";
  return `${monthStr}/${yearStr}`;
}

export default function SavedPaymentCardsPanel({
  savedCards,
  isAddingCard = false,
  busyCardId = null,
  busyAction = null,
  onAddCard,
  onSetDefault,
  onDeleteCard,
  title = "Saved Payment Cards (Spending)",
  subtitle = "Used when paying for subscriptions, hiring tradespeople, or AnyRoller rides.",
  emptyTitle = "Link Payment Card via Stripe",
  emptyDescription = "Save a card inside Stripe's PCI-DSS Level 1 Vault to pay for jobs, subscriptions, add-ons, or rides. AnyTrader never sees or stores your card details.",
  showSecurityFooter = true,
}: SavedPaymentCardsPanelProps) {
  return (
    <div className="bg-white rounded-2xl border border-black p-5 sm:p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-100 border border-black flex items-center justify-center shrink-0">
            <CreditCard className="w-5 h-5 text-black" />
          </div>
          <div>
            <h3 className="text-base font-black text-black leading-tight">{title}</h3>
            <p className="text-xs font-medium text-black mt-0.5">{subtitle}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={onAddCard}
          disabled={isAddingCard}
          className="inline-flex items-center justify-center gap-1.5 text-xs font-black text-white bg-blue-600 hover:bg-blue-700 px-3.5 py-2 rounded-xl border border-black transition-colors disabled:opacity-50 shrink-0 cursor-pointer"
        >
          {isAddingCard ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Opening Stripe...</span>
            </>
          ) : (
            <>
              <Plus className="w-3.5 h-3.5" />
              <span>{savedCards.length > 0 ? "Add Another Card" : "Add New Card"}</span>
            </>
          )}
        </button>
      </div>

      {savedCards.length > 0 ? (
        <div className="space-y-3">
          {savedCards.map((card) => {
            const isCardBusy = busyCardId === card.id;
            const isSettingDefault = isCardBusy && busyAction === "default";
            const isDeleting = isCardBusy && busyAction === "delete";
            const isDefault = Boolean(card.isDefault);

            return (
              <div
                key={card.id}
                className="bg-slate-50 rounded-2xl border border-black p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="w-12 h-8 rounded-lg bg-slate-900 border border-black text-white flex items-center justify-center font-black text-[10px] tracking-wider uppercase shrink-0">
                    {(card.brand || "CARD").slice(0, 6)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-black text-black">
                        •••• •••• •••• {card.last4}
                      </p>
                      {isDefault && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-emerald-900 bg-emerald-100 border border-black px-2 py-0.5 rounded-lg">
                          <Check className="w-3 h-3" /> Default
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-black font-medium mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span>Expires {formatExpiry(card.expMonth, card.expYear)}</span>
                      <span>•</span>
                      <span className="inline-flex items-center gap-0.5 font-bold text-indigo-800">
                        <Lock className="w-3 h-3" /> Stripe Vaulted
                      </span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!isDefault && (
                    <button
                      type="button"
                      onClick={() => onSetDefault(card.id)}
                      disabled={Boolean(busyCardId)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white hover:bg-blue-50 text-black text-xs font-bold border border-black transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      {isSettingDefault ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Star className="w-3.5 h-3.5 text-amber-600" />
                      )}
                      <span>{isSettingDefault ? "Saving..." : "Set as Default"}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onDeleteCard(card.id)}
                    disabled={Boolean(busyCardId)}
                    aria-label={`Remove card ending in ${card.last4}`}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white hover:bg-red-50 text-red-700 text-xs font-bold border border-black transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {isDeleting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    <span>{isDeleting ? "Removing..." : "Remove"}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-slate-50 rounded-2xl border border-black p-6 text-center space-y-4">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-white border border-black text-[11px] font-bold text-black">
            <Lock className="w-3.5 h-3.5 text-indigo-700" />
            <span>Secured & Processed Directly by Stripe</span>
          </div>

          <div className="w-12 h-12 bg-indigo-600 text-white rounded-xl border border-black flex items-center justify-center mx-auto">
            <CreditCard className="w-6 h-6" />
          </div>

          <div className="space-y-1 max-w-md mx-auto">
            <h4 className="text-sm font-black text-black">{emptyTitle}</h4>
            <p className="text-xs text-black font-medium leading-relaxed">{emptyDescription}</p>
          </div>

          <button
            type="button"
            onClick={onAddCard}
            disabled={isAddingCard}
            className="inline-flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-xl text-xs font-black border border-black transition-colors disabled:opacity-50 cursor-pointer"
          >
            {isAddingCard ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Connecting to Stripe...</span>
              </>
            ) : (
              <>
                <Lock className="w-3.5 h-3.5" />
                <span>Link Card via Stripe (PCI-1 Secure)</span>
              </>
            )}
          </button>

          <p className="text-[11px] text-black font-medium">
            Supports Visa, Mastercard, American Express & Apple Pay
          </p>
        </div>
      )}

      {showSecurityFooter && (
        <div className="mt-4 flex items-start gap-3 bg-blue-50 p-3.5 rounded-xl border border-black">
          <ShieldCheck className="w-4 h-4 text-blue-700 shrink-0 mt-0.5" />
          <div className="text-xs text-black font-medium leading-relaxed">
            <span className="font-black">Zero local card storage:</span>{" "}
            Card details are encrypted directly inside Stripe's PCI-DSS Level 1 vault.{" "}
            <span className="inline-flex items-center gap-0.5 font-bold">
              <Shield className="w-3 h-3 text-emerald-700" /> Tokenized billing only.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
