import React, { useState, useEffect } from "react";
import { auth, db, doc, setDoc, onSnapshot } from "@/src/firebase";
import { Loader2, Plus, Trash2, Save, AlertCircle, Edit2, X, Check } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/src/lib/utils";

const formatCommissionPercent = (decimalRate: unknown): number => {
  const num = Number(decimalRate) || 0;
  const pct = num > 1 ? num : num * 100;
  return Number(pct.toFixed(2));
};

interface Tier {
  price: number;
  commission: number;
  description: string;
  features: string[];
  color: string;
  
  // Trade specific
  maxQuotes?: number;
  maxAcceptedQuotes?: number;
  leadFee?: number;

  // Ride specific
  destinationFilters?: number;
  priorityDispatch?: number;
  advanceBookingDays?: number;
}

interface EditingState {
  model: string;
  tierKey: string;
  data: Tier;
}

interface AdminTierManagerProps {
  modelsToShow?: string[];
}

export default function AdminTierManager({ modelsToShow }: AdminTierManagerProps) {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [pendingDeleteTier, setPendingDeleteTier] = useState<{ model: string; tierKey: string } | null>(null);
  const [pendingAddTierModel, setPendingAddTierModel] = useState<string | null>(null);
  const [newTierKeyInput, setNewTierKeyInput] = useState("");

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "platform_config", "global_tiers"), (snapshot) => {
      if (snapshot.exists()) {
        setConfig(snapshot.data());
        setHasUnsavedChanges(false);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const handleTierUpdate = () => {
    if (!editing) return;
    
    setConfig((prev: any) => {
      const newConfig = { ...prev };
      newConfig.providerModels[editing.model].tiers[editing.tierKey] = editing.data;
      return newConfig;
    });
    setEditing(null);
    setHasUnsavedChanges(true); // Mark as unsaved
  };

  const handleDeleteTier = (model: string, tierKey: string) => {
    setPendingDeleteTier({ model, tierKey });
  };

  const confirmDeleteTier = () => {
    if (!pendingDeleteTier) return;
    const { model, tierKey } = pendingDeleteTier;
    setPendingDeleteTier(null);
    setConfig((prev: any) => {
      const newConfig = { ...prev };
      delete newConfig.providerModels[model].tiers[tierKey];
      return newConfig;
    });
    setHasUnsavedChanges(true);
    toast.success(`Removed ${tierKey} tier (click Deploy Now to publish).`);
  };

  const handleAddTier = (model: string) => {
    setNewTierKeyInput("");
    setPendingAddTierModel(model);
  };

  const confirmAddTier = () => {
    if (!pendingAddTierModel) return;
    const model = pendingAddTierModel;
    const tierKey = newTierKeyInput.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!tierKey) {
      toast.error("Please enter a valid tier ID (letters, numbers, hyphen or underscore).");
      return;
    }
    if (config.providerModels[model].tiers[tierKey]) {
      toast.error("A tier with this ID already exists.");
      return;
    }

    const newTier: Tier = {
      price: 0,
      commission: 0.1,
      description: "New tier description",
      features: ["Feature 1"],
      color: "bg-white border-black"
    };

    if (model === 'one_off_trades') {
      newTier.maxQuotes = 10;
      newTier.maxAcceptedQuotes = 2;
      newTier.leadFee = 0;
    } else if (model === 'on_demand_transport') {
      newTier.destinationFilters = 2;
      newTier.advanceBookingDays = 7;
      newTier.priorityDispatch = 0;
    }

    setConfig((prev: any) => ({
      ...prev,
      providerModels: {
        ...prev.providerModels,
        [model]: {
          ...prev.providerModels[model],
          tiers: {
            ...prev.providerModels[model].tiers,
            [tierKey]: newTier
          }
        }
      }
    }));

    setEditing({ model, tierKey, data: newTier });
    setHasUnsavedChanges(true);
    setPendingAddTierModel(null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : "";
      if (!idToken) {
        throw new Error("Admin authentication required to publish pricing tiers.");
      }

      const rawCap =
        config?.providerModels?.one_off_trades?.commissionCapGbp ??
        config?.commissionCapGbp;
      const parsedCap = rawCap === undefined || rawCap === null || rawCap === "" ? 250 : Number(rawCap);
      const safeCapGbp = Number.isFinite(parsedCap) && parsedCap >= 0 ? parsedCap : 250;

      const providerModelsPatch: Record<string, any> = {};
      for (const [modelKey, modelVal] of Object.entries<any>(config?.providerModels || {})) {
        if (modelsToShow && modelsToShow.length > 0 && !modelsToShow.includes(modelKey)) {
          continue;
        }
        if (modelKey === "one_off_trades") {
          providerModelsPatch[modelKey] = {
            ...modelVal,
            commissionCapGbp: safeCapGbp,
          };
        } else {
          providerModelsPatch[modelKey] = modelVal;
        }
      }

      const oneOffTiers = providerModelsPatch?.one_off_trades?.tiers;
      const syncedFeeTiers = oneOffTiers
        ? Object.entries(oneOffTiers).map(([tierKey, data]: [string, any]) => {
            let name = "Free Explorer";
            const lower = tierKey.toLowerCase();
            if (lower === 'pro' || lower.includes('silver')) name = "Silver Professional";
            else if (lower === 'premium' || lower === 'gold' || lower.includes('elite')) name = "Gold Elite";
            else if (lower === 'platinum' || lower.includes('enterprise')) name = "Platinum Enterprise";
            else if (lower === 'payg' || lower.includes('free')) name = "Free Explorer";
            else name = tierKey.charAt(0).toUpperCase() + tierKey.slice(1);

            return {
              name,
              price: Number(data.price) || 0,
              commission: formatCommissionPercent(data.commission),
              maxQuotes: Number(data.maxQuotes) || 9999,
              maxAcceptedQuotes: Number(data.maxAcceptedQuotes) || 9999,
              leadFee: Number(data.leadFee) || 0,
              description: data.description || "",
              features: data.features || [],
              limitPeriod: "monthly"
            };
          })
        : undefined;

      const res = await fetch("/api/admin/pricing-config/publish", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          tempConfig: { commissionCapGbp: safeCapGbp },
          ...(syncedFeeTiers ? { feeTiers: syncedFeeTiers } : {}),
          commissionCapGbp: safeCapGbp,
          globalTiersProviderModels: providerModelsPatch,
        }),
      });
      const resData = await res.json().catch(() => ({}));
      if (!res.ok || !resData?.success) {
        throw new Error(resData?.error || `Failed to publish tiers (${res.status})`);
      }

      // Preserve AnyRoller ride_fees sync only when on_demand_transport is explicitly managed
      if (providerModelsPatch?.on_demand_transport) {
        const taxiCommission = providerModelsPatch.on_demand_transport?.tiers?.standard?.commission;
        if (typeof taxiCommission === 'number') {
          await setDoc(doc(db, "platform_config", "ride_fees"), {
            fees: { platformCommission: formatCommissionPercent(taxiCommission) }
          }, { merge: true });
        }
      }

      setHasUnsavedChanges(false);
      toast.success(`Tiers & commission cap (£${safeCapGbp === 0 ? "Uncapped" : safeCapGbp}) atomically published (v${resData.configVersion}).`);
    } catch (error: any) {
      console.error("Error saving tiers:", error);
      toast.error(error?.message || "Failed to save tiers. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;

  if (!config) {
    return (
      <div className="p-12 text-center bg-slate-50 rounded-2xl border-2 border-dashed border-black">
        <AlertCircle className="w-12 h-12 text-slate-400 mx-auto mb-4" />
        <h3 className="text-xl font-bold text-slate-700 mb-2">Tier Configuration Not Found</h3>
        <p className="text-slate-500 mb-6 max-w-md mx-auto">
          The global tier configuration has not been initialized yet. Click the button below to create the initial configuration with canonical platform tiers.
        </p>
        <button 
          onClick={async () => {
            const initialConfig = {
              commissionCapGbp: 250,
              providerModels: {
                one_off_trades: {
                  commissionCapGbp: 250,
                  tiers: {
                    payg: {
                      price: 0,
                      commission: 0.05,
                      maxQuotes: 5,
                      maxAcceptedQuotes: 2,
                      leadFee: 0,
                      description: "Start risk-free. 5% Platform Commission. Standard Visibility.",
                      features: ["5 Quotes/month", "5% Platform Commission", "Standard Profile Visibility"],
                      color: "bg-slate-50 border-black"
                    },
                    pro: {
                      price: 19.99,
                      commission: 0.035,
                      maxQuotes: 30,
                      maxAcceptedQuotes: 10,
                      leadFee: 0,
                      description: "For active tradespeople. 3.5% Platform Commission. Priority Alerts.",
                      features: ["30 Quotes/month", "3.5% Commission", "Instant Lead Alerts", "Priority Support", "Branded Invoicing"],
                      color: "bg-blue-50 border-black"
                    },
                    premium: {
                      price: 49.99,
                      commission: 0.025,
                      maxQuotes: 9999,
                      maxAcceptedQuotes: 9999,
                      leadFee: 0,
                      description: "Top tier for established trades. 2.5% Commission. Highest trust rank.",
                      features: ["Unlimited Quotes", "2.5% Commission", "Gold Trust Badge", "Instant Match Priority", "AI Material List Assistant"],
                      color: "bg-amber-50 border-black"
                    },
                    platinum: {
                      price: 99.99,
                      commission: 0.015,
                      maxQuotes: 9999,
                      maxAcceptedQuotes: 9999,
                      leadFee: 0,
                      description: "Enterprise scale for multi-seat trade crews. 1.5% Commission.",
                      features: ["Unlimited Quotes", "1.5% Commission", "Multi-seat Crew Dispatch", "Dedicated Account Manager", "Custom TradeOS Reports"],
                      color: "bg-purple-50 border-black"
                    }
                  }
                },
                on_demand_transport: {
                  tiers: {
                    standard: { price: 0, commission: 0.12, description: "Standard Driver", destinationFilters: 2, advanceBookingDays: 7, priorityDispatch: 0, features: ["Unlimited trips", "Standard Dispatch", "12% Platform Commission"], color: "bg-green-50 border-black" },
                    gold: { price: 49.99, commission: 0.10, description: "Priority Driver", destinationFilters: 4, advanceBookingDays: 14, priorityDispatch: 50, features: ["Priority Airport Queue", "Higher Earning Potential", "10% Platform Commission"], color: "bg-amber-50 border-black" },
                  }
                },
                homeowners: {
                  tiers: {
                    standard: { price: 0, maxQuotes: 0, maxAcceptedQuotes: 0, commission: 0, leadFee: 0, description: "Standard Homeowner", features: ["Post unlimited jobs", "Compare quotes", "Direct messaging"], color: "bg-slate-50 border-black" },
                    landlord: { price: 19, maxQuotes: 0, maxAcceptedQuotes: 0, commission: 0, leadFee: 0, description: "Premium Landlord Portfolio", features: ["Multi-property dashboard", "CP12 & EICR automated compliance", "Tenant repair reporting bridge"], color: "bg-blue-50 border-black" }
                  }
                }
              }
            };
            setConfig(initialConfig);
            await setDoc(doc(db, "platform_config", "global_tiers"), initialConfig);
          }}
          className="bg-blue-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-blue-700"
        >
          Initialize Canonical Tiers
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {Object.entries(config.providerModels || {})
        .filter(([model]) => !modelsToShow || modelsToShow.includes(model))
        .map(([model, modelData]: [string, any]) => (
        <div key={model} className="space-y-4">
          <div className="flex flex-wrap justify-between items-center gap-3">
            <h3 className="text-sm font-bold uppercase tracking-wider text-black">{model.replace(/_/g, " ")}</h3>
            {model === "one_off_trades" && (
              <div className="flex items-center gap-3 bg-white px-4 py-2 rounded-xl border border-black">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-wider text-black">Max Commission Cap (£)</p>
                  <p className="text-[10px] text-slate-600">0 = No Cap (default £250)</p>
                </div>
                <input
                  type="number"
                  min={0}
                  step={10}
                  value={
                    modelData?.commissionCapGbp ??
                    config?.commissionCapGbp ??
                    250
                  }
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    const nextCap = Number.isFinite(val) && val >= 0 ? val : 0;
                    setConfig((prev: any) => ({
                      ...prev,
                      commissionCapGbp: nextCap,
                      providerModels: {
                        ...(prev?.providerModels || {}),
                        one_off_trades: {
                          ...(prev?.providerModels?.one_off_trades || {}),
                          commissionCapGbp: nextCap,
                        },
                      },
                    }));
                    setHasUnsavedChanges(true);
                  }}
                  className="w-24 px-2.5 py-1.5 rounded-lg border border-black bg-slate-50 text-sm font-bold text-black text-right"
                />
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {Object.entries(modelData.tiers || {}).map(([tierKey, tier]: [string, any]) => {
              const isEditing = editing?.model === model && editing?.tierKey === tierKey;
              
              if (isEditing) {
                return (
                  <div key={tierKey} className="p-6 rounded-2xl border shadow-lg bg-white border-blue-500 ring-2 ring-blue-500/20">
                    <div className="flex justify-between items-start mb-4">
                      <h4 className="font-bold text-lg uppercase">{tierKey}</h4>
                      <div className="flex gap-2">
                        <button onClick={() => setEditing(null)} className="p-1 text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
                        <button onClick={handleTierUpdate} className="p-1 text-green-600 hover:text-green-700"><Check className="w-4 h-4" /></button>
                      </div>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label className="text-[10px] font-bold uppercase text-slate-400">Description</label>
                        <input 
                          type="text" 
                          value={editing.data.description ?? ""} 
                          onChange={(e) => setEditing({...editing, data: {...editing.data, description: e.target.value}})}
                          className="w-full text-sm border-b border-black py-1 focus:outline-none focus:border-blue-500"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] font-bold uppercase text-slate-400">Price (£)</label>
                          <input 
                            type="number" 
                            step="0.01"
                            value={editing.data.price ?? 0} 
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              setEditing({...editing, data: {...editing.data, price: isNaN(val) ? 0 : val}});
                            }}
                            className="w-full text-sm border-b border-black py-1 focus:outline-none focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold uppercase text-slate-400">Comm (%)</label>
                          <input 
                            type="number" 
                            step="0.1"
                            min={0}
                            max={100}
                            value={formatCommissionPercent(editing.data.commission)} 
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              const decimalVal = isNaN(val) ? 0 : Math.round((Math.max(0, Math.min(100, val)) / 100) * 1000000) / 1000000;
                              setEditing({...editing, data: {...editing.data, commission: decimalVal}});
                            }}
                            className="w-full text-sm border-b border-black py-1 focus:outline-none focus:border-blue-500"
                          />
                        </div>
                      </div>
                      
                      {model === 'one_off_trades' && (
                        <>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-[10px] font-bold uppercase text-slate-400">Max Quotes</label>
                              <input 
                                type="number" 
                                value={editing.data.maxQuotes ?? 0} 
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  setEditing({...editing, data: {...editing.data, maxQuotes: isNaN(val) ? 0 : val}});
                                }}
                                className="w-full text-sm border-b border-black py-1 focus:outline-none focus:border-blue-500"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold uppercase text-slate-400">Lead Fee (£)</label>
                              <input 
                                type="number" 
                                step="0.1"
                                value={editing.data.leadFee ?? 0} 
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value);
                                  setEditing({...editing, data: {...editing.data, leadFee: isNaN(val) ? 0 : val}});
                                }}
                                className="w-full text-sm border-b border-black py-1 focus:outline-none focus:border-blue-500"
                              />
                            </div>
                          </div>
                        </>
                      )}

                      {model === 'on_demand_transport' && (
                        <>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="text-[10px] font-bold uppercase text-slate-400">Dest. Filters / Day</label>
                              <input 
                                type="number" 
                                value={editing.data.destinationFilters ?? 0} 
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  setEditing({...editing, data: {...editing.data, destinationFilters: isNaN(val) ? 0 : val}});
                                }}
                                className="w-full text-sm border-b border-black py-1 focus:outline-none focus:border-blue-500"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold uppercase text-slate-400">Adv. Booking (Days)</label>
                              <input 
                                type="number" 
                                value={editing.data.advanceBookingDays ?? 0} 
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  setEditing({...editing, data: {...editing.data, advanceBookingDays: isNaN(val) ? 0 : val}});
                                }}
                                className="w-full text-sm border-b border-black py-1 focus:outline-none focus:border-blue-500"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] font-bold uppercase text-slate-400">Priority Dispatch Level (0-100)</label>
                            <input 
                              type="number" 
                              value={editing.data.priorityDispatch ?? 0} 
                              onChange={(e) => {
                                const val = parseInt(e.target.value);
                                setEditing({...editing, data: {...editing.data, priorityDispatch: isNaN(val) ? 0 : val}});
                              }}
                              className="w-full text-sm border-b border-black py-1 focus:outline-none focus:border-blue-500"
                            />
                          </div>
                        </>
                      )}

                      <div>
                        <label className="text-[10px] font-bold uppercase text-slate-400">Features (comma separated)</label>
                        <textarea 
                          value={(editing.data.features || []).join(", ")} 
                          onChange={(e) => setEditing({...editing, data: {...editing.data, features: e.target.value.split(",").map(f => f.trim())}})}
                          className="w-full text-sm border-b border-black py-1 focus:outline-none focus:border-blue-500 h-16"
                        />
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div key={tierKey} className={cn("group flex flex-col p-6 rounded-[24px] border shadow-sm transition-all hover:shadow-lg relative overflow-hidden bg-white/50 backdrop-blur-sm", tier.color || "bg-white border-black")}>
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <h4 className="font-extrabold text-xl text-slate-900 uppercase tracking-tight">{tierKey}</h4>
                    </div>
                    <div className="flex gap-2 transition-opacity">
                      <button 
                        onClick={() => setEditing({ model, tierKey, data: { ...tier } })}
                        className="p-1.5 bg-white text-blue-600 hover:bg-blue-50 rounded-lg transition-colors border border-black shadow-sm"
                        title="Edit Tier"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => handleDeleteTier(model, tierKey)}
                        className="p-1.5 bg-white text-red-600 hover:bg-red-50 rounded-lg transition-colors border border-black shadow-sm"
                        title="Delete Tier"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  
                  <p className="text-slate-500 text-sm font-medium mb-4 min-h-[40px]">{tier.description}</p>
                  
                  <div className="mb-6">
                    <div className="flex items-baseline gap-1">
                      <span className="text-4xl font-black text-slate-900">£{tier.price}</span>
                      <span className="text-sm font-bold text-slate-400">/ mo</span>
                    </div>
                  </div>

                  <div className="space-y-1 mb-6 flex-1">
                    <div className="flex justify-between items-center py-2.5 border-b border-black/50">
                      <span className="text-sm font-medium text-slate-500">Commission</span>
                      <span className="text-sm font-bold text-slate-900 bg-slate-100 px-2.5 py-0.5 rounded-full">{formatCommissionPercent(tier.commission)}%</span>
                    </div>

                    {model === 'one_off_trades' && (
                      <>
                        <div className="flex justify-between items-center py-2.5 border-b border-black/50">
                          <span className="text-sm font-medium text-slate-500">Job Quotes</span>
                          <span className="text-sm font-bold text-slate-900 bg-slate-100 px-2.5 py-0.5 rounded-full">{(tier.maxQuotes ?? 0) >= 9999 ? 'Unlimited' : tier.maxQuotes}</span>
                        </div>
                        {tier.leadFee !== undefined && tier.leadFee > 0 && (
                          <div className="flex justify-between items-center py-2.5 border-b border-black/50">
                            <span className="text-sm font-medium text-slate-500">Lead Fee</span>
                            <span className="text-sm font-bold text-slate-900 bg-slate-100 px-2.5 py-0.5 rounded-full">£{tier.leadFee}</span>
                          </div>
                        )}
                      </>
                    )}

                    {model === 'on_demand_transport' && (
                      <>
                        <div className="flex justify-between items-center py-2.5 border-b border-black/50">
                          <span className="text-sm font-medium text-slate-500">Dest. Filters</span>
                          <span className="text-sm font-bold text-slate-900 bg-slate-100 px-2.5 py-0.5 rounded-full">{tier.destinationFilters ?? 0} / Day</span>
                        </div>
                        <div className="flex justify-between items-center py-2.5 border-b border-black/50">
                          <span className="text-sm font-medium text-slate-500">Adv. Booking</span>
                          <span className="text-sm font-bold text-slate-900 bg-slate-100 px-2.5 py-0.5 rounded-full">{tier.advanceBookingDays ?? 0} Days</span>
                        </div>
                        <div className="flex justify-between items-center py-2.5 border-b border-black/50">
                          <span className="text-sm font-medium text-slate-500">Priority Dispatch</span>
                          <span className="text-sm font-bold text-slate-900 bg-slate-100 px-2.5 py-0.5 rounded-full">Lvl {tier.priorityDispatch ?? 0}</span>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="mt-auto bg-slate-50/80 p-4 rounded-xl border border-black/50">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Included Features</p>
                    <ul className="space-y-2.5">
                      {tier.features?.map((f: string) => (
                        <li key={f} className="flex items-start gap-2.5 text-sm text-slate-700 font-medium">
                          <div className="p-0.5 bg-emerald-100 rounded-full mt-0.5 shrink-0">
                            <Check className="w-3 h-3 text-emerald-600" />
                          </div>
                          <span className="leading-tight">{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
            <button 
              onClick={() => handleAddTier(model)}
              className="flex flex-col items-center justify-center border-2 border-dashed border-black bg-slate-50/50 rounded-[24px] hover:bg-slate-50 hover:border-black hover:shadow-inner text-slate-400 hover:text-slate-600 p-6 min-h-[420px] transition-all group"
            >
              <div className="w-12 h-12 bg-white rounded-full shadow-sm border border-black flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Plus className="w-5 h-5" />
              </div>
              <span className="font-bold uppercase tracking-widest text-xs">Add Tier</span>
            </button>
          </div>
        </div>
      ))}
      <AnimatePresence>
        {(hasUnsavedChanges || editing) && (
          <motion.div 
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex justify-center"
          >
            <div className="bg-orange-600 shadow-2xl shadow-orange-600/30 text-white rounded-full p-2 pr-6 pl-4 flex items-center gap-4">
              <div className="bg-white/20 p-2 rounded-full">
                <AlertCircle className="w-5 h-5 text-white" />
              </div>
              <div>
                <p className="font-bold text-sm">Unsaved Changes</p>
                <p className="text-orange-100 text-xs">Don't forget to deploy your tier updates</p>
              </div>
              <button 
                onClick={handleSave}
                disabled={saving || editing !== null}
                className="ml-4 flex items-center gap-2 bg-white text-orange-600 px-5 py-2 rounded-full font-bold shadow-sm hover:bg-orange-50 disabled:opacity-50 transition-all active:scale-95 whitespace-nowrap"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {editing ? "Finish Editing..." : "Deploy Now"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {pendingDeleteTier && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white border border-black rounded-xl max-w-sm w-full p-5 space-y-4">
            <h3 className="text-base font-black text-black">Delete Tier?</h3>
            <p className="text-sm text-black">
              Are you sure you want to delete the <span className="font-bold">{pendingDeleteTier.tierKey}</span> tier?
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDeleteTier(null)}
                className="px-4 py-2 text-xs font-bold text-black bg-slate-100 border border-black rounded-lg hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteTier}
                className="px-4 py-2 text-xs font-bold text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                Delete Tier
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingAddTierModel && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white border border-black rounded-xl max-w-sm w-full p-5 space-y-4">
            <h3 className="text-base font-black text-black">Add New Tier</h3>
            <p className="text-sm text-black">
              Enter a unique ID for this tier (e.g. <span className="font-mono font-bold">premium</span> or <span className="font-mono font-bold">gold</span>):
            </p>
            <input
              type="text"
              value={newTierKeyInput}
              onChange={(e) => setNewTierKeyInput(e.target.value)}
              placeholder="e.g. premium"
              className="w-full px-3 py-2 text-sm text-black bg-white border border-black rounded-lg outline-none focus:ring-2 focus:ring-blue-600"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingAddTierModel(null)}
                className="px-4 py-2 text-xs font-bold text-black bg-slate-100 border border-black rounded-lg hover:bg-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmAddTier}
                className="px-4 py-2 text-xs font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700"
              >
                Create Tier
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
