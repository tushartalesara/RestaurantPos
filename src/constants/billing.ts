export type SupportedBillingCountry = {
  code: string
  name: string
  currencyCode: string
  defaultTaxLabel: string
}

export const SUPPORTED_BILLING_COUNTRIES: SupportedBillingCountry[] = [
  { code: "GB", name: "United Kingdom", currencyCode: "GBP", defaultTaxLabel: "VAT" },
  { code: "US", name: "United States", currencyCode: "USD", defaultTaxLabel: "Sales Tax" },
  { code: "IN", name: "India", currencyCode: "INR", defaultTaxLabel: "GST" },
  { code: "AE", name: "United Arab Emirates", currencyCode: "AED", defaultTaxLabel: "VAT" },
  { code: "AU", name: "Australia", currencyCode: "AUD", defaultTaxLabel: "GST" },
  { code: "CA", name: "Canada", currencyCode: "CAD", defaultTaxLabel: "HST" },
]

export function getSupportedBillingCountry(countryCode: string | null | undefined): SupportedBillingCountry | null {
  const normalizedCode = String(countryCode || "")
    .trim()
    .toUpperCase()

  return SUPPORTED_BILLING_COUNTRIES.find((country) => country.code === normalizedCode) || null
}
