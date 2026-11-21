import { LogOut } from "lucide-react";
import { useState } from "react";

import type { ShopInfo } from "../../../shared/types";
import { ShopLocationCard } from "@/components/shop-location-card";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/primitives";

/**
 * Required once, before anything else: a shop without a location can't open,
 * because the location is what stops prints being sent from home with a photo
 * of the QR. Saving it updates the shop and the app opens by itself.
 */
export function LocationSetupScreen({ shop }: { shop: ShopInfo }) {
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div className="h-dvh overflow-y-auto bg-subtle">
      <div className="mx-auto max-w-[680px] px-8 py-8">
        <div className="flex items-center justify-between">
          <Logo />
          <Button
            variant="ghost"
            size="sm"
            loading={signingOut}
            onClick={async () => {
              setSigningOut(true);
              await window.zerox.logout();
            }}
          >
            {!signingOut && <LogOut aria-hidden />} Sign out
          </Button>
        </div>
        <p className="mt-10 text-overline text-muted-foreground">One-time setup · {shop.shopName}</p>
        <h1 className="mt-2 text-title">Set your shop&apos;s location</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          Zerox Buddy only takes prints from customers who are at your shop. Set where your shop is once, and you&apos;re ready to start.
        </p>
        <div className="mt-6">
          <ShopLocationCard shop={shop} required />
        </div>
      </div>
    </div>
  );
}
