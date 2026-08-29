import Image from "next/image";

export default function Logo({ size = 40 }: { size?: number }) {
  return <Image src="/cloud-mark.svg" width={size} height={size} alt="Salva Cloud" priority />;
}
