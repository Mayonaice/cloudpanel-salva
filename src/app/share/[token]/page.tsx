import ShareClient from "@/components/ShareClient";

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  return <ShareClient token={(await params).token} />;
}
