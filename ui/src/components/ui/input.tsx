import * as React from "react"

import { cn } from "@/lib/utils"

// Studio convention: form inputs use the `.field-wrap` + `.field-input`
// composition defined in `index.css` so every input shares one named class
// rather than re-pasting the Tailwind chain. The wrapper provides the
// border / card surface / focus ring; the inner input carries placeholder
// + text styling. `className` and `aria-*` props still land on the inner
// `<input>` so existing consumers keep working unchanged.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  // Variant-specific classes are gated on `type` so a text input doesn't
  // carry styling rules for variants it doesn't render. Currently only
  // `type="file"` needs an extra class to style the browser's built-in
  // file-picker button (`::file-selector-button`).
  const variantClass = type === "file" ? "field-input-file-button" : null;
  return (
    <div
      className={cn(
        "field-wrap",
        // Lift aria-invalid + disabled styling from the inner input up to
        // the wrapper since the border lives on `.field-wrap`, not on the
        // input itself.
        "[&:has(input[aria-invalid=true])]:border-destructive",
        "[&:has(input[aria-invalid=true])]:ring-2",
        "[&:has(input[aria-invalid=true])]:ring-destructive/20",
        "[&:has(input:disabled)]:cursor-not-allowed",
        "[&:has(input:disabled)]:opacity-50",
      )}
    >
      <input
        type={type}
        data-slot="input"
        className={cn("field-input", variantClass, className)}
        {...props}
      />
    </div>
  )
}

export { Input }
