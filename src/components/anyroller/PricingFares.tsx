import React, { useState, useEffect } from "react";
import {
  Tag, Save, Activity, Zap, CarFront,
  MapPin, Clock, CreditCard, ShieldCheck,
  RefreshCcw, HandCoins, Calculator, Dog, Heart, AlertTriangle, Route
} from "lucide-react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { toast } from "sonner";

const PricingFares = () => {
  const [globalConfig, setGlobalConfig] = useState({
    baseFare: 3.50,
    distanceRate: 1.30,
    timeRate: 0.15,
    waitRatePerMinute: 0.25,
    minFare: 5.00,
    commissionRate: 12.0,
    fixedTripFee: 0.00,
    priorityFee: 3.00,
    petFee: 3.00,
    maxTipGbp: 50.00,
    freeWaitMinutes: 3,
    driverWaitTimeLimitMins: 5,
    abandonmentFee: 5.00,
    maxPendingPlatformFeesGbp: 50.00,
    allowMidJourneyEdits: true,
    vehicleMultipliers: {
      standard: 1.0,
      electric: 1.15,
      '6seater': 1.4,
      executive: 1.5,
      '8seater': 2.0,
      luxury: 2.2,
      wav: 2.5
    }
  });

  const [originalConfig, setOriginalConfig] = useState(globalConfig);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [simCategory, setSimCategory] = useState<string>('standard');
  const [simDistance, setSimDistance] = useState<number>(5.0);
  const [simDuration, setSimDuration] = useState<number>(15);
  const [simPriority, setSimPriority] = useState<boolean>(false);
  const [simPet, setSimPet] = useState<boolean>(false);
  const [simPaidWaitMins, setSimPaidWaitMins] = useState<number>(0);
  const [simTip, setSimTip] = useState<number>(0);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const docSnap = await getDoc(doc(db, "platform_config", "rides"));
        if (docSnap.exists()) {
          const data = docSnap.data();
          setGlobalConfig(prev => {
            const newConfig = {
              baseFare: Number(data.baseFare) > 0 ? Number(data.baseFare) : prev.baseFare,
              distanceRate: Number(data.distanceRate) > 0 ? Number(data.distanceRate) : prev.distanceRate,
              timeRate: data.timeRate !== undefined ? Number(data.timeRate) : prev.timeRate,
              waitRatePerMinute: data.waitRatePerMinute !== undefined ? Number(data.waitRatePerMinute) : prev.waitRatePerMinute,
              minFare: Number(data.minFare) > 0 ? Number(data.minFare) : prev.minFare,
              commissionRate: (data.commissionRate !== undefined ? Number(data.commissionRate) * 100 : prev.commissionRate),
              fixedTripFee: data.fixedTripFee !== undefined ? Number(data.fixedTripFee) : prev.fixedTripFee,
              priorityFee: data.priorityFee !== undefined ? Number(data.priorityFee) : prev.priorityFee,
              petFee: data.petFee !== undefined ? Number(data.petFee) : prev.petFee,
              maxTipGbp: data.maxTipGbp !== undefined ? Math.min(50, Math.max(0, Number(data.maxTipGbp))) : prev.maxTipGbp,
              freeWaitMinutes: data.freeWaitMinutes !== undefined ? Number(data.freeWaitMinutes) : prev.freeWaitMinutes,
              driverWaitTimeLimitMins: Number(data.driverWaitTimeLimitMins) > 0 ? Number(data.driverWaitTimeLimitMins) : prev.driverWaitTimeLimitMins,
              abandonmentFee: data.abandonmentFee !== undefined ? Number(data.abandonmentFee) : prev.abandonmentFee,
              maxPendingPlatformFeesGbp: Number(data.maxPendingPlatformFeesGbp) > 0 ? Number(data.maxPendingPlatformFeesGbp) : prev.maxPendingPlatformFeesGbp,
              allowMidJourneyEdits: typeof data.allowMidJourneyEdits === "boolean" ? data.allowMidJourneyEdits : prev.allowMidJourneyEdits,
              vehicleMultipliers: { ...prev.vehicleMultipliers, ...(data.vehicleMultipliers || {}) }
            };
            setOriginalConfig(newConfig);
            return newConfig;
          });
        }
      } catch (err) {
        console.error("Failed to load fare config", err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchConfig();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const clampedMaxTip = Math.min(50, Math.max(0, Number(globalConfig.maxTipGbp) || 0));
      const canonicalVehicleTypes = [
        { id: "standard", name: "Standard", multiplier: globalConfig.vehicleMultipliers.standard },
        { id: "electric", name: "Electric (EV)", multiplier: globalConfig.vehicleMultipliers.electric },
        { id: "executive", name: "Executive", multiplier: globalConfig.vehicleMultipliers.executive },
        { id: "luxury", name: "Luxury / VIP", multiplier: globalConfig.vehicleMultipliers.luxury },
        { id: "6seater", name: "6-Seater XL", multiplier: globalConfig.vehicleMultipliers["6seater"] },
        { id: "8seater", name: "8-Seater Minibus", multiplier: globalConfig.vehicleMultipliers["8seater"] },
        { id: "wav", name: "Wheelchair Accessible", multiplier: globalConfig.vehicleMultipliers.wav },
      ];
      const nextToSave = {
        ...globalConfig,
        maxTipGbp: clampedMaxTip,
      };
      await setDoc(doc(db, "platform_config", "rides"), {
        baseFare: nextToSave.baseFare,
        distanceRate: nextToSave.distanceRate,
        timeRate: nextToSave.timeRate,
        waitRatePerMinute: nextToSave.waitRatePerMinute,
        minFare: nextToSave.minFare,
        commissionRate: nextToSave.commissionRate / 100,
        fixedTripFee: nextToSave.fixedTripFee,
        priorityFee: nextToSave.priorityFee,
        petFee: nextToSave.petFee,
        maxTipGbp: clampedMaxTip,
        freeWaitMinutes: nextToSave.freeWaitMinutes,
        freeWaitSeconds: Math.round(nextToSave.freeWaitMinutes * 60),
        driverWaitTimeLimitMins: nextToSave.driverWaitTimeLimitMins,
        abandonmentFee: nextToSave.abandonmentFee,
        maxPendingPlatformFeesGbp: nextToSave.maxPendingPlatformFeesGbp,
        allowMidJourneyEdits: nextToSave.allowMidJourneyEdits,
        vehicleMultipliers: nextToSave.vehicleMultipliers,
        vehicleTypes: canonicalVehicleTypes,
      }, { merge: true });
      setGlobalConfig(nextToSave);
      setOriginalConfig(nextToSave);
      toast.success("Rates & platform controls synced live across Passenger, Driver & Android apps.");
    } catch (err) {
      console.error("Failed to save fare config", err);
      toast.error("Failed to publish pricing rates. Check admin permissions.");
    } finally {
      setIsSaving(false);
    }
  };

  const Toggle = ({ enabled, onClick }: { enabled: boolean, onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors border border-black ${enabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );

  if (isLoading) {
    return <div className="p-8 flex items-center justify-center"><Activity className="animate-spin text-black" /></div>;
  }

  const hasChanges = JSON.stringify(globalConfig) !== JSON.stringify(originalConfig);

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6 pb-32">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-black pb-6">
        <div>
          <h1 className="text-2xl font-bold text-black flex items-center">
            <Tag className="mr-2 text-indigo-600" />
            Pricing & Fares Engine
          </h1>
          <p className="text-black/70 text-sm mt-1">Configure global base rates, add-ons, tip caps, wait rules, and mid-journey controls synced live to all terminals and Android Driver App.</p>
        </div>

        <button
          onClick={handleSave}
          disabled={isSaving || !hasChanges}
          className={`flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg text-sm font-bold transition-all ${
            (!hasChanges || isSaving)
              ? 'bg-gray-200 text-gray-500 border border-black/30 shadow-none cursor-not-allowed'
              : 'bg-black text-white border border-black shadow-[0_4px_0_rgb(100,100,100)] active:translate-y-[4px] active:shadow-none'
          }`}
        >
          {isSaving ? <Activity className="animate-spin" size={18} /> : <Save size={18} />}
          {isSaving ? "Syncing to Firebase..." : "Publish Rates"}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left Column: Global Rates + Add-Ons & Policies */}
        <div className="space-y-6">
          <div className="bg-white border border-black rounded-xl shadow-sm overflow-hidden flex flex-col">
            <div className="bg-gray-50 border-b border-black px-6 py-4 flex items-center gap-2">
              <CarFront className="text-blue-600" size={20} />
              <h2 className="font-bold text-black text-lg">Global Live Variables</h2>
            </div>

            <div className="p-6 space-y-4">
              <div className="flex justify-between items-center bg-white border border-black p-4 rounded-xl">
                <div>
                  <h3 className="font-bold text-black flex items-center gap-2"><Tag size={16} /> Base Departure Fare</h3>
                  <p className="text-xs text-black/70 mt-1">Starting charge applied per completed dispatch (also late-cancel fee).</p>
                </div>
                <div className="flex items-center font-bold text-lg text-black">
                  £ <input type="number" step="0.1" min="0" value={globalConfig.baseFare} onChange={(e) => setGlobalConfig({...globalConfig, baseFare: parseFloat(e.target.value) || 0})} className="ml-1 w-20 px-2 py-1 border border-black rounded-lg text-center" />
                </div>
              </div>

              <div className="flex justify-between items-center bg-white border border-black p-4 rounded-xl">
                <div>
                  <h3 className="font-bold text-black flex items-center gap-2"><MapPin size={16} /> Distance Rate (Per Mile)</h3>
                  <p className="text-xs text-black/70 mt-1">Applied to route distance (and mid-journey actual + remaining miles).</p>
                </div>
                <div className="flex items-center font-bold text-lg text-black">
                  £ <input type="number" step="0.1" min="0" value={globalConfig.distanceRate} onChange={(e) => setGlobalConfig({...globalConfig, distanceRate: parseFloat(e.target.value) || 0})} className="ml-1 w-20 px-2 py-1 border border-black rounded-lg text-center" />
                </div>
              </div>

              <div className="flex justify-between items-center bg-white border border-black p-4 rounded-xl">
                <div>
                  <h3 className="font-bold text-black flex items-center gap-2"><Clock size={16} /> Time Rate (Per Minute)</h3>
                  <p className="text-xs text-black/70 mt-1">Live journey duration multiplier applied for transit estimates.</p>
                </div>
                <div className="flex items-center font-bold text-lg text-black">
                  £ <input type="number" step="0.05" min="0" value={globalConfig.timeRate} onChange={(e) => setGlobalConfig({...globalConfig, timeRate: parseFloat(e.target.value) || 0})} className="ml-1 w-20 px-2 py-1 border border-black rounded-lg text-center" />
                </div>
              </div>

              <div className="flex justify-between items-center bg-white border border-black p-4 rounded-xl">
                <div>
                  <h3 className="font-bold text-black flex items-center gap-2"><HandCoins size={16} /> Wait Rate (Per Minute)</h3>
                  <p className="text-xs text-black/70 mt-1">Charged per minute waiting beyond the free grace period.</p>
                </div>
                <div className="flex items-center font-bold text-lg text-black">
                  £ <input type="number" step="0.05" min="0" value={globalConfig.waitRatePerMinute} onChange={(e) => setGlobalConfig({...globalConfig, waitRatePerMinute: parseFloat(e.target.value) || 0})} className="ml-1 w-20 px-2 py-1 border border-black rounded-lg text-center bg-red-50 outline-none" />
                </div>
              </div>

              <div className="flex justify-between items-center bg-gray-50 border border-black p-4 rounded-xl">
                <div>
                  <h3 className="font-bold text-black flex items-center gap-2"><ShieldCheck size={16} /> System Minimum Fare</h3>
                  <p className="text-xs text-black/70 mt-1">Lowest floor for Standard rides (scaled by vehicle tier multiplier).</p>
                </div>
                <div className="flex items-center font-bold text-lg text-black">
                  £ <input type="number" step="0.1" min="0" value={globalConfig.minFare} onChange={(e) => setGlobalConfig({...globalConfig, minFare: parseFloat(e.target.value) || 0})} className="ml-1 w-20 px-2 py-1 border border-black rounded-lg text-center" />
                </div>
              </div>
            </div>

            <div className="bg-blue-50/50 p-4 border-t border-black text-sm text-black flex items-center gap-2 font-medium">
              <RefreshCcw size={16} className="text-blue-600" /> Live changes sync immediately to Passenger, Driver Web &amp; Android apps.
            </div>
          </div>

          {/* Add-On Fees, Tip Cap & Mid-Journey Policy Controls */}
          <div className="bg-white border border-black rounded-xl shadow-sm overflow-hidden flex flex-col">
            <div className="bg-gray-50 border-b border-black px-6 py-4 flex items-center gap-2">
              <Zap className="text-blue-600" size={20} />
              <h2 className="font-bold text-black text-lg">Add-Ons, Tip Cap &amp; Trip Rules</h2>
            </div>

            <div className="p-6 space-y-4">
              <div className="flex justify-between items-center bg-white border border-black p-4 rounded-xl">
                <div>
                  <h3 className="font-bold text-black flex items-center gap-2"><Zap size={16} className="text-blue-600" /> Priority Boost Fee</h3>
                  <p className="text-xs text-black/70 mt-1">Flat surcharge added after vehicle tier &amp; surge for priority queue dispatch.</p>
                </div>
                <div className="flex items-center font-bold text-lg text-black">
                  £ <input type="number" step="0.5" min="0" max="50" value={globalConfig.priorityFee} onChange={(e) => setGlobalConfig({...globalConfig, priorityFee: Math.max(0, parseFloat(e.target.value) || 0)})} className="ml-1 w-20 px-2 py-1 border border-black rounded-lg text-center" />
                </div>
              </div>

              <div className="flex justify-between items-center bg-white border border-black p-4 rounded-xl">
                <div>
                  <h3 className="font-bold text-black flex items-center gap-2"><Dog size={16} className="text-blue-600" /> Pet Friendly Add-On Fee</h3>
                  <p className="text-xs text-black/70 mt-1">Flat surcharge added after vehicle tier &amp; surge when travelling with a pet.</p>
                </div>
                <div className="flex items-center font-bold text-lg text-black">
                  £ <input type="number" step="0.5" min="0" max="50" value={globalConfig.petFee} onChange={(e) => setGlobalConfig({...globalConfig, petFee: Math.max(0, parseFloat(e.target.value) || 0)})} className="ml-1 w-20 px-2 py-1 border border-black rounded-lg text-center" />
                </div>
              </div>

              <div className="flex justify-between items-center bg-emerald-50/50 border border-black p-4 rounded-xl">
                <div>
                  <h3 className="font-bold text-black flex items-center gap-2"><Heart size={16} className="text-emerald-600" /> Max Passenger Card Tip Cap</h3>
                  <p className="text-xs text-black/70 mt-1">Hard safety ceiling on card tips (platform max £50.00; 100% goes to driver).</p>
                </div>
                <div className="flex items-center font-bold text-lg text-black">
                  £ <input type="number" step="1" min="0" max="50" value={globalConfig.maxTipGbp} onChange={(e) => setGlobalConfig({...globalConfig, maxTipGbp: Math.min(50, Math.max(0, parseFloat(e.target.value) || 0))})} className="ml-1 w-20 px-2 py-1 border border-black rounded-lg text-center bg-white" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex justify-between items-center bg-white border border-black p-3.5 rounded-xl">
                  <div>
                    <h3 className="font-bold text-black text-sm">Free Wait Grace</h3>
                    <p className="text-[11px] text-black/70">Minutes before wait fee</p>
                  </div>
                  <div className="flex items-center font-bold text-black">
                    <input type="number" step="1" min="0" max="30" value={globalConfig.freeWaitMinutes} onChange={(e) => setGlobalConfig({...globalConfig, freeWaitMinutes: Math.max(0, parseInt(e.target.value, 10) || 0)})} className="w-14 px-2 py-1 border border-black rounded-lg text-center" />
                    <span className="text-xs ml-1">m</span>
                  </div>
                </div>

                <div className="flex justify-between items-center bg-white border border-black p-3.5 rounded-xl">
                  <div>
                    <h3 className="font-bold text-black text-sm">Wait Limit</h3>
                    <p className="text-[11px] text-black/70">Max driver wait mins</p>
                  </div>
                  <div className="flex items-center font-bold text-black">
                    <input type="number" step="1" min="1" max="30" value={globalConfig.driverWaitTimeLimitMins} onChange={(e) => setGlobalConfig({...globalConfig, driverWaitTimeLimitMins: Math.max(1, parseInt(e.target.value, 10) || 5)})} className="w-14 px-2 py-1 border border-black rounded-lg text-center" />
                    <span className="text-xs ml-1">m</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex justify-between items-center bg-white border border-black p-3.5 rounded-xl">
                  <div>
                    <h3 className="font-bold text-black text-sm flex items-center gap-1"><AlertTriangle size={14} className="text-amber-600" /> Abandonment Fee</h3>
                    <p className="text-[11px] text-black/70">Rider no-show penalty</p>
                  </div>
                  <div className="flex items-center font-bold text-black">
                    £<input type="number" step="0.5" min="0" max="100" value={globalConfig.abandonmentFee} onChange={(e) => setGlobalConfig({...globalConfig, abandonmentFee: Math.max(0, parseFloat(e.target.value) || 0)})} className="ml-1 w-16 px-2 py-1 border border-black rounded-lg text-center" />
                  </div>
                </div>

                <div className="flex justify-between items-center bg-white border border-black p-3.5 rounded-xl">
                  <div>
                    <h3 className="font-bold text-black text-sm">Cash-Fee Cap</h3>
                    <p className="text-[11px] text-black/70">Pause dispatch above</p>
                  </div>
                  <div className="flex items-center font-bold text-black">
                    £<input type="number" step="5" min="5" max="500" value={globalConfig.maxPendingPlatformFeesGbp} onChange={(e) => setGlobalConfig({...globalConfig, maxPendingPlatformFeesGbp: Math.max(5, parseFloat(e.target.value) || 50)})} className="ml-1 w-16 px-2 py-1 border border-black rounded-lg text-center" />
                  </div>
                </div>
              </div>

              <div className="flex justify-between items-center bg-white border border-black p-4 rounded-xl">
                <div className="pr-4">
                  <h3 className="font-bold text-black flex items-center gap-2"><Route size={16} className="text-indigo-600" /> Allow Mid-Journey Route Edits</h3>
                  <p className="text-xs text-black/70 mt-1">Let passengers change dropoff or add/edit remaining stops while in progress (recalculates actual + remaining distance).</p>
                </div>
                <Toggle
                  enabled={globalConfig.allowMidJourneyEdits}
                  onClick={() => setGlobalConfig({...globalConfig, allowMidJourneyEdits: !globalConfig.allowMidJourneyEdits})}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Platform Commission & Vehicle Tier Multipliers */}
        <div className="space-y-6">
          <div className="bg-slate-900 border border-white/20 rounded-xl p-6 shadow-sm text-white">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <CreditCard className="text-emerald-400" size={20} /> Platform Commission
              </h2>
              <ShieldCheck className="text-emerald-400" size={20} />
            </div>
            <p className="text-sm text-slate-300 mb-6">Deducted from base fare only (never from tips) prior to Stripe Connect driver payout routing. Gold Drivers stay at 10% / £0 fixed.</p>

            <div className="space-y-4">
              <div className="bg-slate-950 border border-white/20 rounded-lg p-5 flex justify-between items-center">
                <div>
                  <span className="text-sm font-bold text-white block mb-1">Standard Take Rate</span>
                  <span className="text-xs text-slate-400 font-mono">platform_config.commissionRate</span>
                </div>
                <div className="flex items-center text-2xl font-black text-emerald-400">
                  <input type="number" step="0.1" min="0" max="50" value={globalConfig.commissionRate} onChange={(e) => setGlobalConfig({...globalConfig, commissionRate: parseFloat(e.target.value) || 0})} className="w-20 px-2 py-1 bg-transparent border-b-2 border-emerald-400 outline-none text-right mr-1" /> %
                </div>
              </div>

              <div className="bg-slate-950 border border-white/20 rounded-lg p-5 flex justify-between items-center">
                <div>
                  <span className="text-sm font-bold text-white block mb-1">Fixed Trip Fee</span>
                  <span className="text-xs text-slate-400 font-mono">platform_config.fixedTripFee</span>
                </div>
                <div className="flex items-center text-2xl font-black text-emerald-400">
                  £ <input type="number" step="0.05" min="0" max="10" value={globalConfig.fixedTripFee} onChange={(e) => setGlobalConfig({...globalConfig, fixedTripFee: parseFloat(e.target.value) || 0})} className="w-20 px-2 py-1 bg-transparent border-b-2 border-emerald-400 outline-none text-right mr-1" />
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-black rounded-xl p-6 shadow-sm">
            <h2 className="text-lg font-bold text-black mb-4">Vehicle Tier Mathematics</h2>
            <p className="text-sm text-black/70 mb-4">Live adjustments to these multipliers instantly shift pricing for each vehicle class across Passenger, Driver Web &amp; Android apps.</p>

            <div className="space-y-2">
              {[
                { key: 'standard', label: 'Standard Car', step: '0.1' },
                { key: 'electric', label: 'Electric (EV)', step: '0.05' },
                { key: 'executive', label: 'Executive', step: '0.1' },
                { key: 'luxury', label: 'Luxury / VIP', step: '0.1' },
                { key: '6seater', label: '6 Seater XL', step: '0.1' },
                { key: '8seater', label: '8 Seater Max', step: '0.1' },
                { key: 'wav', label: 'Wheelchair (WAV)', step: '0.1' },
              ].map((tier) => (
                <div key={tier.key} className="flex justify-between items-center text-sm py-2 border-b border-gray-200 last:border-b-0">
                  <span className="font-bold text-black">{tier.label}</span>
                  <div className="flex items-center text-black font-bold">
                    x <input
                      type="number"
                      step={tier.step}
                      min="0.5"
                      max="10"
                      value={(globalConfig.vehicleMultipliers as Record<string, number>)[tier.key] ?? 1.0}
                      onChange={(e) => setGlobalConfig({
                        ...globalConfig,
                        vehicleMultipliers: {
                          ...globalConfig.vehicleMultipliers,
                          [tier.key]: parseFloat(e.target.value) || 0,
                        },
                      })}
                      className="ml-1 w-16 px-2 py-1 bg-emerald-50 border border-black rounded text-center outline-none"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Live Fare Simulator Section */}
      <div className="bg-white border border-black rounded-xl shadow-sm overflow-hidden mt-6">
        <div className="bg-slate-900 px-6 py-4 flex items-center gap-2 border-b border-black">
          <Calculator className="text-emerald-400" size={20} />
          <h2 className="font-bold text-white text-lg">Live Fare &amp; Payout Simulator</h2>
        </div>
        <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Simulator Controls */}
          <div className="space-y-5">
            <div>
              <label className="text-sm font-bold text-black flex justify-between mb-2">
                <span>Trip Distance (Miles)</span>
                <span className="text-emerald-700 font-bold">{simDistance.toFixed(1)} mi</span>
              </label>
              <input
                type="range" min="0.5" max="50" step="0.5"
                value={simDistance}
                onChange={(e) => setSimDistance(parseFloat(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
              />
            </div>
            <div>
              <label className="text-sm font-bold text-black flex justify-between mb-2">
                <span>Trip Duration (Minutes)</span>
                <span className="text-emerald-700 font-bold">{simDuration} mins</span>
              </label>
              <input
                type="range" min="1" max="120" step="1"
                value={simDuration}
                onChange={(e) => setSimDuration(parseInt(e.target.value, 10))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-black flex justify-between mb-1.5">
                  <span>Paid Wait (Mins)</span>
                  <span className="text-amber-700 font-bold">{simPaidWaitMins}m</span>
                </label>
                <input
                  type="range" min="0" max="30" step="1"
                  value={simPaidWaitMins}
                  onChange={(e) => setSimPaidWaitMins(parseInt(e.target.value, 10))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-amber-600"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-black flex justify-between mb-1.5">
                  <span>Passenger Tip (Max £{globalConfig.maxTipGbp.toFixed(0)})</span>
                  <span className="text-emerald-700 font-bold">£{Math.min(simTip, globalConfig.maxTipGbp).toFixed(0)}</span>
                </label>
                <input
                  type="range" min="0" max={Math.max(0, Math.min(50, globalConfig.maxTipGbp))} step="1"
                  value={Math.min(simTip, globalConfig.maxTipGbp)}
                  onChange={(e) => setSimTip(parseInt(e.target.value, 10))}
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-emerald-600"
                />
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setSimPriority(!simPriority)}
                className={`flex-1 py-2 px-3 rounded-lg border border-black text-xs font-bold flex items-center justify-center gap-1.5 ${simPriority ? 'bg-blue-600 text-white' : 'bg-white text-black'}`}
              >
                <Zap size={14} /> Priority (+£{globalConfig.priorityFee.toFixed(2)})
              </button>
              <button
                type="button"
                onClick={() => setSimPet(!simPet)}
                className={`flex-1 py-2 px-3 rounded-lg border border-black text-xs font-bold flex items-center justify-center gap-1.5 ${simPet ? 'bg-blue-600 text-white' : 'bg-white text-black'}`}
              >
                <Dog size={14} /> Pet (+£{globalConfig.petFee.toFixed(2)})
              </button>
            </div>

            <div>
              <label className="text-sm font-bold text-black mb-2 block">Vehicle Category</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  { id: 'standard', name: 'Standard Car' },
                  { id: 'electric', name: 'Electric' },
                  { id: 'executive', name: 'Executive' },
                  { id: 'luxury', name: 'Luxury' },
                  { id: '6seater', name: '6 Seater XL' },
                  { id: '8seater', name: '8 Seater Max' },
                  { id: 'wav', name: 'Wheelchair' },
                ].map(cat => (
                  <button
                    type="button"
                    key={cat.id}
                    onClick={() => setSimCategory(cat.id)}
                    className={`py-2.5 px-3 text-xs font-bold rounded-lg border transition-all ${
                      simCategory === cat.id
                        ? 'bg-emerald-50 border-black text-black shadow-sm ring-2 ring-emerald-500'
                        : 'bg-white border-black/30 text-black hover:bg-gray-50'
                    }`}
                  >
                    {cat.name}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Simulator Output */}
          {(() => {
            const subDist = simDistance * globalConfig.distanceRate;
            const subTime = simDuration * globalConfig.timeRate;
            const baseRaw = globalConfig.baseFare + subDist + subTime;
            const baseFloored = Math.max(globalConfig.minFare, baseRaw);
            const multiplier = (globalConfig.vehicleMultipliers as Record<string, number>)[simCategory] || 1.0;
            const catMinFare = globalConfig.minFare * multiplier;
            const multipliedFare = baseFloored * multiplier;
            const vehicleSubtotal = Math.max(multipliedFare, catMinFare);
            const priorityAdd = simPriority ? globalConfig.priorityFee : 0;
            const petAdd = simPet ? globalConfig.petFee : 0;
            const waitAdd = simPaidWaitMins * globalConfig.waitRatePerMinute;
            const finalFareExclTip = vehicleSubtotal + priorityAdd + petAdd + waitAdd;
            const effectiveTip = Math.min(simTip, globalConfig.maxTipGbp);
            const totalCustomerFare = finalFareExclTip + effectiveTip;
            const platformFee = Math.min(finalFareExclTip, finalFareExclTip * (globalConfig.commissionRate / 100) + globalConfig.fixedTripFee);
            const driverPayout = (finalFareExclTip - platformFee) + effectiveTip;
            const isMinFareApplied = catMinFare > baseRaw * multiplier;

            return (
              <div className="bg-gray-50 border border-black rounded-xl p-5 flex flex-col justify-between">
                <div>
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-black mb-4 border-b border-black pb-2">Estimated Fare Breakdown</h3>
                  <div className="space-y-2 text-sm text-black">
                    <div className="flex justify-between">
                      <span>Base Departure Charge</span>
                      <span>£{globalConfig.baseFare.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Distance ({simDistance.toFixed(1)}mi × £{globalConfig.distanceRate.toFixed(2)})</span>
                      <span>£{subDist.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Time ({simDuration}m × £{globalConfig.timeRate.toFixed(2)})</span>
                      <span>£{subTime.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between font-bold pt-1 border-t border-gray-300 mt-1">
                      <span>Vehicle Subtotal (× {multiplier.toFixed(2)})</span>
                      <span>£{vehicleSubtotal.toFixed(2)}</span>
                    </div>
                    {isMinFareApplied && (
                      <div className="flex justify-between font-bold text-orange-800 text-xs bg-orange-50 p-2 rounded-lg border border-black">
                        <span>Minimum Fare Floor (£{globalConfig.minFare.toFixed(2)} × {multiplier.toFixed(2)})</span>
                        <span>£{catMinFare.toFixed(2)}</span>
                      </div>
                    )}
                    {priorityAdd > 0 && (
                      <div className="flex justify-between font-bold text-blue-700">
                        <span>Priority Boost</span>
                        <span>+£{priorityAdd.toFixed(2)}</span>
                      </div>
                    )}
                    {petAdd > 0 && (
                      <div className="flex justify-between font-bold text-blue-700">
                        <span>Pet Friendly</span>
                        <span>+£{petAdd.toFixed(2)}</span>
                      </div>
                    )}
                    {waitAdd > 0 && (
                      <div className="flex justify-between font-bold text-amber-700">
                        <span>Paid Wait ({simPaidWaitMins}m)</span>
                        <span>+£{waitAdd.toFixed(2)}</span>
                      </div>
                    )}
                    {effectiveTip > 0 && (
                      <div className="flex justify-between font-bold text-emerald-700">
                        <span>Passenger Tip (0% commission)</span>
                        <span>+£{effectiveTip.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-6 border-t-2 border-black pt-4">
                  <div className="flex justify-between items-end mb-4">
                    <span className="text-sm font-black uppercase tracking-wider text-black">Total Customer Fare</span>
                    <span className="text-3xl font-black text-black">£{totalCustomerFare.toFixed(2)}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="bg-white border border-black text-center p-3 rounded-xl shadow-sm">
                      <span className="block text-[10px] text-black/70 font-bold uppercase tracking-wider mb-0.5">
                        Platform Cut ({globalConfig.commissionRate}%{globalConfig.fixedTripFee > 0 ? ` + £${globalConfig.fixedTripFee.toFixed(2)}` : ''})
                      </span>
                      <span className="block font-black text-black text-lg">£{platformFee.toFixed(2)}</span>
                    </div>
                    <div className="bg-emerald-50 border border-black text-center p-3 rounded-xl shadow-sm">
                      <span className="block text-[10px] text-black font-bold uppercase tracking-wider mb-0.5">Driver Payout (incl. Tip)</span>
                      <span className="block font-black text-black text-lg">£{driverPayout.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
};

export default PricingFares;

