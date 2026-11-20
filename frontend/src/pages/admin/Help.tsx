import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  ArrowRight, BarChart3, Boxes, HelpCircle, Keyboard, Package, ScanLine, Search, ShoppingCart, Tags, Truck,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";

const quickStart = [
  { icon: Package, title: "Products", to: "/products", text: "Create products, set cost and selling price, and keep the general pool stocked." },
  { icon: Boxes, title: "Branches", to: "/branches", text: "Allocate general-pool stock to a branch, then open a branch to see its inventory." },
  { icon: ScanLine, title: "Counting sessions", to: "/sessions", text: "Scan with the camera or a hardware scanner, review variance, then complete the session." },
  { icon: ShoppingCart, title: "Purchasing", to: "/purchases/orders", text: "Vendor → purchase order → receive → bill → payment. Receiving is what increases stock." },
  { icon: Truck, title: "Inventory ops", to: "/inventory/transfers", text: "Move stock between branches, adjust counts, and write off damaged goods." },
  { icon: BarChart3, title: "Reports", to: "/reports/inventory-valuation", text: "Valuation, stock aging, and PO aging — all exportable to CSV." },
  { icon: Tags, title: "Taxonomy", to: "/brands", text: "Keep brands, categories, and units clean so imports and filters stay reliable." },
];

const faqs = [
  {
    q: "Why didn't my purchase order change stock levels?",
    a: "Purchase orders are commitments, not stock movements. Stock only increases when you record a Purchase Receive against the order and pick a destination branch.",
  },
  {
    q: "What is the difference between the general pool and branch stock?",
    a: "The general pool is unallocated inventory. Assigning to a branch moves quantity out of the available pool into that branch's allocation. Available = pool quantity minus everything allocated.",
  },
  {
    q: "How does the 3-way match on bills work?",
    a: "A bill is compared against the linked receive and purchase order. If billed quantity or unit price differs, the bill is flagged as a quantity or price mismatch and shows the reason.",
  },
  {
    q: "Can I receive fewer items than I ordered?",
    a: "Yes. Enter the received quantity per line; the order stays Partially Received until every line is fulfilled, then it closes automatically.",
  },
  {
    q: "How do I fix a wrong count?",
    a: "Use Inventory → Adjustments to set the correct quantity with a reason, or Write-offs for damaged and lost goods. Both are recorded in the movement ledger.",
  },
  {
    q: "Does the scanner work on a phone?",
    a: "Yes. Open a session on mobile and use camera scanning for continuous decode with audio and haptic feedback, or keep using a keyboard-wedge hardware scanner.",
  },
  {
    q: "What happens if I lose connectivity mid-count?",
    a: "Session counts are saved locally as a draft, so a refresh or dropped connection does not lose your progress. The header badge shows your connectivity state.",
  },
  {
    q: "How do I switch to Arabic?",
    a: "Use the language switcher in the header. The whole interface mirrors to right-to-left, including tables and navigation.",
  },
  {
    q: "Who can delete records?",
    a: "Permissions are defined per role in the Roles page. Delete actions are limited to roles that hold the delete permission for that module.",
  },
  {
    q: "Where can I see who changed what?",
    a: "The Audit Log records mutating actions with the module, action, entity, and timestamp.",
  },
];

const shortcuts = [
  { keys: "Ctrl / ⌘ + B", action: "Toggle the sidebar" },
  { keys: "Tab / Shift + Tab", action: "Move between form fields" },
  { keys: "Enter", action: "Commit a scanned barcode in a session" },
  { keys: "Esc", action: "Close a dialog or cancel an inline edit" },
  { keys: "Ctrl / ⌘ + P", action: "Print the current purchase order view" },
];

export default function Help() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");

  const filteredFaqs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return faqs;
    return faqs.filter(f => f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q));
  }, [query]);

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <HelpCircle className="h-7 w-7" />
          {t("help.title", "Help & guides")}
        </h1>
        <p className="text-muted-foreground">
          {t("help.description", "Quick starts, answers to common questions, and keyboard shortcuts.")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("help.quickStart", "Module quick start")}</CardTitle>
          <CardDescription>{t("help.quickStartDescription", "Jump straight into the part of the app you need.")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {quickStart.map(item => (
            <Link
              key={item.to}
              to={item.to}
              className="group rounded-lg border p-4 transition-colors hover:bg-muted/60"
            >
              <div className="flex items-center gap-2 font-medium">
                <item.icon className="h-4 w-4" />
                {item.title}
                <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{item.text}</p>
            </Link>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("help.faq", "Frequently asked questions")}</CardTitle>
          <CardDescription>{t("help.faqDescription", "Search the answers below.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t("help.searchPlaceholder", "Search help…")}
              className="ps-9"
              aria-label={t("help.searchPlaceholder", "Search help…")}
            />
          </div>
          {filteredFaqs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("help.noResults", "No answers matched your search.")}
            </p>
          ) : (
            <Accordion type="single" collapsible className="w-full">
              {filteredFaqs.map((f, i) => (
                <AccordionItem key={f.q} value={`faq-${i}`}>
                  <AccordionTrigger className="text-start">{f.q}</AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">{f.a}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Keyboard className="h-4 w-4" />
              {t("help.shortcuts", "Keyboard shortcuts")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {shortcuts.map(s => (
              <div key={s.keys} className="flex items-center justify-between gap-4 border-b pb-2 last:border-0 last:pb-0">
                <span className="text-sm text-muted-foreground">{s.action}</span>
                <Badge variant="outline" className="font-mono">{s.keys}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("help.about", "About this app")}</CardTitle>
            <CardDescription>{t("help.aboutDescription", "Version and support details.")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">{t("help.version", "Version")}</span><span className="font-medium">1.0.0</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{t("help.languages", "Languages")}</span><span className="font-medium">English · العربية</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">{t("help.auditTrail", "Audit trail")}</span><Link to="/audit-log" className="font-medium underline">{t("help.openAuditLog", "Open audit log")}</Link></div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}