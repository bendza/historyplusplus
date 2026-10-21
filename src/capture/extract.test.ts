import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { hasSensitiveFields, isPaymentFrameSrc } from './extract';

const doc = (body: string) => parseHTML(`<!doctype html><html><body>${body}</body></html>`).document as unknown as Document;

describe('hasSensitiveFields', () => {
  it('flags password, one-time-code and card fields', () => {
    expect(hasSensitiveFields(doc('<input type="password">'))).toBe(true);
    expect(hasSensitiveFields(doc('<input autocomplete="cc-number">'))).toBe(true);
    expect(hasSensitiveFields(doc('<input autocomplete="one-time-code">'))).toBe(true);
    expect(hasSensitiveFields(doc('<input autocomplete="username current-password">'))).toBe(true);
  });

  it('flags checkout pages whose card fields are hosted iframes', () => {
    expect(hasSensitiveFields(doc('<iframe src="https://js.stripe.com/v3/elements-inner-card-1a2b.html"></iframe>'))).toBe(true);
    expect(hasSensitiveFields(doc('<iframe src="https://checkoutshopper-live.adyen.com/checkoutshopper/securedfields/x.html"></iframe>'))).toBe(true);
  });

  it('leaves ordinary pages alone, including ones that merely load Stripe.js', () => {
    expect(hasSensitiveFields(doc('<p>Hello</p><input type="search"><iframe src="https://www.youtube.com/embed/x"></iframe>'))).toBe(false);
    expect(hasSensitiveFields(doc('<iframe src="https://js.stripe.com/v3/controller-abc.html"></iframe>'))).toBe(false);
  });
});

describe('isPaymentFrameSrc', () => {
  it('matches card-field frames only', () => {
    expect(isPaymentFrameSrc('https://assets.braintreegateway.com/web/3.97.2/html/hosted-fields-frame.min.html')).toBe(true);
    expect(isPaymentFrameSrc('https://js.checkout.com/frames/v2/index.html')).toBe(true);
    expect(isPaymentFrameSrc('https://evil-js.stripe.com.example/elements-inner-card')).toBe(false);
    expect(isPaymentFrameSrc('not a url')).toBe(false);
  });
});
