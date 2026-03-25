// scripts/seed.ts — CheckRada v8
// SECURITY FIX:
//   [CRITICAL] SHA256 password hashing → bcrypt (rounds=12)

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function toSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
}

async function generateSlug(title: string): Promise<string> {
  const base = toSlug(title);
  let slug = base, n = 1;
  while (await prisma.market.findUnique({ where: { slug } })) slug = `${base}-${n++}`;
  return slug;
}

async function main() {
  console.log('🌱 Seeding CheckRada database v8...');

  const user = await prisma.user.upsert({
    where:  { phone: '254712345678' },
    update: {},
    create: { phone: '254712345678', name: 'Test User', kycStatus: 'VERIFIED',
              balanceKes: 5000, agreedToTerms: true, confirmedAge: true },
  });
  console.log(`✅ User A: ${user.phone}`);

  const userB = await prisma.user.upsert({
    where:  { phone: '254798765432' },
    update: {},
    create: { phone: '254798765432', name: 'Test User B', kycStatus: 'VERIFIED',
              balanceKes: 3000, agreedToTerms: true, confirmedAge: true },
  });
  console.log(`✅ User B: ${userB.phone}`);

  // FIX [CRITICAL]: bcrypt(rounds=12) replaces SHA256 for password storage
  const adminPassword = process.env.ADMIN_SEED_PASSWORD;
  if (!adminPassword) {
    throw new Error('ADMIN_SEED_PASSWORD env var is required before seeding. Set it first.');
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.adminAccount.upsert({
    where:  { email: 'admin@checkrada.co.ke' },
    update: {},
    create: { email: 'admin@checkrada.co.ke', passwordHash, name: 'CheckRada Admin' },
  });
  console.log(`✅ Admin: ${admin.email} (bcrypt hashed)`);
  console.log(`   ⚠️  Remove ADMIN_SEED_PASSWORD from env immediately after seeding`);

  const marketDefs = [
    { title: 'Will William Ruto complete his full first presidential term?', description: 'Will President William Ruto serve until the end of his first term in 2027 without being removed via impeachment, resignation, or any other means?', category: 'POLITICS' as const, sourceNote: 'Official Kenya Gazette / IEBC announcement', closesAt: new Date('2027-08-31'), yesPool: 1850, noPool: 1000 },
    { title: 'Will Kenya hold its 2027 general elections on schedule?', description: 'Will the IEBC conduct Kenya\'s general election on the constitutionally mandated date in August 2027 without postponement?', category: 'POLITICS' as const, sourceNote: 'IEBC official calendar', closesAt: new Date('2027-08-15'), yesPool: 1200, noPool: 1000 },
    { title: 'Will the Kenyan Shilling trade below KES 120 to the USD by end of 2025?', description: 'Will the CBK official KES/USD exchange rate fall below 120 at any point before 31 December 2025?', category: 'ECONOMY' as const, sourceNote: 'Central Bank of Kenya daily exchange rate bulletin', closesAt: new Date('2025-12-31'), yesPool: 1000, noPool: 1400 },
    { title: 'Will the NSE 20 Share Index close above 2,500 by end of 2025?', description: 'Will the NSE 20-Share Index close above 2,500 points on the last trading day of December 2025?', category: 'ECONOMY' as const, sourceNote: 'NSE official closing data', closesAt: new Date('2025-12-31'), yesPool: 1100, noPool: 1000 },
    { title: 'Will Kenya\'s GDP growth exceed 5% in 2025?', description: 'Will KNBS report real GDP growth above 5% for full year 2025?', category: 'ECONOMY' as const, sourceNote: 'KNBS GDP Statistical Release Q4 2025', closesAt: new Date('2026-03-31'), yesPool: 1000, noPool: 1000 },
    { title: 'Will Nairobi receive above-average rainfall in the 2025 long rains?', description: 'Will KMD classify March–May 2025 long rains as above normal for Nairobi county?', category: 'WEATHER' as const, sourceNote: 'Kenya Meteorological Department seasonal bulletin', closesAt: new Date('2025-06-15'), yesPool: 1600, noPool: 1000 },
    { title: 'Will a Kenyan artist win a major international award in 2025?', description: 'Will a Kenyan-born artist win a Grammy, AFRIMMA, MOBO, or equivalent in 2025?', category: 'ENTERTAINMENT' as const, sourceNote: 'Official award ceremony results', closesAt: new Date('2025-12-31'), yesPool: 1000, noPool: 1200 },
    { title: 'Will Kenya launch a national digital ID system by end of 2025?', description: 'Will the government officially launch a functional nationwide digital ID open to all citizens by 31 December 2025?', category: 'TECH' as const, sourceNote: 'Official government press release / Kenya Gazette', closesAt: new Date('2025-12-31'), yesPool: 1000, noPool: 1000 },
    { title: 'Will mobile money transactions in Kenya exceed KES 10 trillion in 2025?', description: 'Will the CBK annual report for 2025 show total mobile money value exceeding KES 10 trillion?', category: 'TECH' as const, sourceNote: 'Central Bank of Kenya Annual Report 2025', closesAt: new Date('2026-04-30'), yesPool: 1300, noPool: 1000 },
    { title: 'Will Kenya\'s population exceed 60 million by end of 2025?', description: 'Will KNBS publish an official estimate placing Kenya\'s population at or above 60 million before 31 December 2025?', category: 'GENERAL' as const, sourceNote: 'KNBS Population Report 2025', closesAt: new Date('2025-12-31'), yesPool: 1000, noPool: 1000 },
  ];

  const createdMarkets: any[] = [];
  for (const def of marketDefs) {
    const slug = await generateSlug(def.title);
    const m = await prisma.market.create({
      data: { slug, title: def.title, description: def.description, category: def.category,
              sourceNote: def.sourceNote, closesAt: def.closesAt, creatorId: user.id,
              yesPool: def.yesPool, noPool: def.noPool },
    });
    createdMarkets.push(m);
    console.log(`✅ Market [${def.category}]: ${m.title.slice(0, 60)}...`);
  }

  const now = new Date();
  const sampleOrders = [
    ...Array.from({ length: 12 }, (_, i) => ({ userId: user.id, marketId: createdMarkets[0].id, side: 'YES' as const, amountKes: 200, shares: 185, pricePerShare: 0.54, status: 'FILLED' as const, createdAt: new Date(now.getTime() - i * 3600000) })),
    ...Array.from({ length: 6  }, (_, i) => ({ userId: userB.id, marketId: createdMarkets[0].id, side: 'NO'  as const, amountKes: 150, shares: 170, pricePerShare: 0.46, status: 'FILLED' as const, createdAt: new Date(now.getTime() - i * 2800000) })),
    ...Array.from({ length: 14 }, (_, i) => ({ userId: userB.id, marketId: createdMarkets[2].id, side: 'NO'  as const, amountKes: 300, shares: 290, pricePerShare: 0.41, status: 'FILLED' as const, createdAt: new Date(now.getTime() - i * 2000000) })),
    ...Array.from({ length: 9  }, (_, i) => ({ userId: user.id, marketId: createdMarkets[5].id,  side: 'YES' as const, amountKes: 500, shares: 460, pricePerShare: 0.62, status: 'FILLED' as const, createdAt: new Date(now.getTime() - i * 4000000) })),
    ...Array.from({ length: 22 }, (_, i) => ({ userId: i % 2 === 0 ? user.id : userB.id, marketId: createdMarkets[7].id, side: i % 3 === 0 ? 'NO' as const : 'YES' as const, amountKes: 100, shares: 90, pricePerShare: 0.50, status: 'FILLED' as const, createdAt: new Date(now.getTime() - i * 1500000) })),
  ];
  await prisma.order.createMany({ data: sampleOrders });
  console.log(`✅ ${sampleOrders.length} sample orders seeded`);

  await prisma.marketChallenge.create({
    data: { question: 'Will Nairobi get significant rain before end of March 2025?', accessCode: 'TEST01', userAId: user.id, userBId: userB.id, stakePerPerson: 200, totalPool: 400, validatorType: 'MUTUAL', status: 'ACTIVE', eventExpiresAt: new Date('2025-03-31') },
  });
  console.log('✅ Sample challenge created (code: TEST01)');

  await prisma.marketProposal.create({
    data: { proposerId: user.id, question: 'Will the Nairobi Expressway be extended to Kikuyu by end of 2026?', category: 'GENERAL', resolutionSource: 'Kenya National Highways Authority announcement', whyCareNote: 'Major infrastructure affecting Nairobi commuters' },
  });
  console.log('✅ Sample proposal created');

  // Seed referral config
  await prisma.referralConfig.upsert({
    where:  { id: 'singleton' },
    update: {},
    create: { id: 'singleton', active: true, referrerRewardKes: 50, refereeMatchKes: 100, minDepositKes: 100 },
  });
  console.log('✅ Referral config seeded');

  console.log('\n🎉 CheckRada v8 seed complete!');
  console.log('\n📋 Credentials:');
  console.log('   Admin: admin@checkrada.co.ke / [ADMIN_SEED_PASSWORD]');
  console.log('   ⚠️  Remove ADMIN_SEED_PASSWORD from env now!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
