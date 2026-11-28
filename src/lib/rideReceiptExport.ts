/**
 * Generates and triggers a clean browser file download for an AnyRoller trip receipt.
 * Uses Blob + temporary <a download> click (iframe-safe, never calls window.open).
 */
export function downloadRideReceipt(ride: Record<string, any>, fallbackWaitRate = 0.25): boolean {
  if (!ride || typeof document === "undefined") return false;

  const rideId = String(ride.id || ride.rideId || "TRIP").slice(0, 16);
  const createdRaw = ride.createdAt?.toDate
    ? ride.createdAt.toDate()
    : ride.createdAt
      ? new Date(ride.createdAt)
      : new Date();
  const dateStr = Number.isNaN(createdRaw.getTime())
    ? new Date().toLocaleString("en-GB")
    : createdRaw.toLocaleString("en-GB");

  const priorityFee = Number(ride.priorityFee ?? 3);
  const petFee = Number(ride.petFee ?? 3);
  const paidWaitSeconds = Number(ride.paidWaitSeconds || 0);
  const waitCharge = (paidWaitSeconds / 60) * fallbackWaitRate;
  const tipAmount = Number(ride.tipAmount || 0);
  const cancelFee = Number(ride.unpaidCancellationFeesOwed || ride.cancellationFee || 0);

  const totalPaid =
    ride.totalFarePaid !== undefined && ride.totalFarePaid !== null
      ? Number(ride.totalFarePaid)
      : ride.finalFare !== undefined && ride.finalFare !== null
        ? ride.fareContractVersion === "v2_excl_tip"
          ? Number(ride.finalFare) + tipAmount
          : Number(ride.finalFare)
        : Number(ride.fareEstimate || ride.price || 0) + waitCharge + tipAmount + cancelFee;

  const paymentLabel =
    ride.paymentMethod === "cash"
      ? "Cash"
      : ride.paymentMethod === "stripe_qr" || (!ride.paymentMethod && !ride.hasCardOnFile)
        ? "Card / QR Code"
        : "Auto Payment (Card)";

  const stopsLines = Array.isArray(ride.stops)
    ? ride.stops
        .filter((s: any) => s && (s.address || s.name))
        .map((s: any, idx: number) => `Stop ${idx + 1}:      ${s.address || s.name}`)
    : [];

  const lines = [
    "========================================",
    "           ANYROLLER TRIP RECEIPT       ",
    "========================================",
    `Receipt ID:  ${rideId}`,
    `Date:        ${dateStr}`,
    `Status:      ${String(ride.status || "completed").toUpperCase()}`,
    `Category:    ${String(ride.carCategory || ride.vehicleCategory || "standard").toUpperCase()}`,
    `Trip Type:   ${ride.rideContext === "business" ? "Business" : "Personal"}`,
    "----------------------------------------",
    `Pickup:      ${ride.pickup || ride.pickupAddress || "N/A"}`,
    ...stopsLines,
    `Dropoff:     ${ride.dropoff || ride.dropoffAddress || "N/A"}`,
    "----------------------------------------",
    `Driver:      ${ride.driverName || "AnyRoller Driver"}`,
    `Vehicle:     ${ride.vehicleInfo || "N/A"} (${ride.vehiclePlate || "N/A"})`,
    "----------------------------------------",
    `Payment:     ${paymentLabel}`,
    ...(ride.isPriority ? [`Priority:    +£${priorityFee.toFixed(2)}`] : []),
    ...(ride.isPetFriendly ? [`Pet Friendly:+£${petFee.toFixed(2)}`] : []),
    ...(paidWaitSeconds > 0
      ? [`Paid Wait:   +£${waitCharge.toFixed(2)} (${Math.floor(paidWaitSeconds / 60)}m)`]
      : []),
    ...(cancelFee > 0 ? [`Prior Fee:   +£${cancelFee.toFixed(2)}`] : []),
    ...(tipAmount > 0 ? [`Driver Tip:  +£${tipAmount.toFixed(2)}`] : []),
    "----------------------------------------",
    `TOTAL PAID:  £${Math.max(0, totalPaid).toFixed(2)}`,
    "========================================",
    "Thank you for riding with AnyRoller.",
  ];

  try {
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `AnyRoller-Receipt-${rideId}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
