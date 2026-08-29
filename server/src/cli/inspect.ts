import 'dotenv/config';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.PROJECT_SENTHOR_STRIPE_KEY!, { maxNetworkRetries: 2 });
const sub = (await stripe.subscriptions.list({ status: 'active', limit: 1, expand: ['data.customer'] })).data[0]! as any;
const cust = sub.customer;
console.log('clés du client :', Object.keys(cust).filter((k: string) => /disc|coupon/i.test(k)).join(', ') || 'aucune');
console.log('');
console.log('customer.discount complet :');
console.log(JSON.stringify(cust.discount, null, 2)?.slice(0, 900));
