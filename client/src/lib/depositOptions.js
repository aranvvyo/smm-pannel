// Customer-facing INR deposit entry points.
//
// INR (UPI) deposits are not open to customers: the payment-gateway connection
// is not active, automatic crediting is disabled, and new INR requests are
// paused by the maintenance switch on the server. Hide the entry points while
// this is false. Set it to true only after the owner approves INR deposits and
// the gateway is verified. The /deposit/inr page is still reachable by direct
// URL and shows the server's maintenance state.
export const INR_DEPOSIT_ENTRY_VISIBLE = false;
