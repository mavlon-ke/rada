// src/app/api/data/applications/route.ts
// SECURITY FIX v8:
//   [MEDIUM] Math.random() → crypto.randomBytes() for reference number generation

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/db/prisma';
import { requireAdmin } from '@/lib/auth/admin';
import { sanitizeText } from '@/lib/security/middleware';
import { withErrorHandling } from '@/lib/security/route-guard';

const ApplicationSchema = z.object({
  firstName:      z.string().min(1).max(50),
  lastName:       z.string().min(1).max(50),
  email:          z.string().email(),
  mobile:         z.string().min(9).max(15),
  city:           z.string().min(1).max(100),
  country:        z.string().min(1).max(100),
  orgName:        z.string().max(200).default(''),   // optional — individuals may leave blank
  orgType:        z.string().min(1).max(100),
  jobTitle:       z.string().max(100).default(''),   // optional — not all applicants have a formal title
  website:        z.string().url().optional().or(z.literal('')),
  planInterest:   z.enum(['lite', 'pro', 'enterprise']),
  useCase:        z.string().min(1).max(100),
  useDescription: z.string().min(2).max(1000),
  dataVolume:     z.string().optional(),
});

// SECURITY FIX: crypto.randomBytes — NOT Math.random()
function generateRefNumber(): string {
  return 'RDA-' + randomBytes(3).toString('hex').toUpperCase();
}

export const POST = withErrorHandling(async (req: NextRequest) => {
  const body   = await req.json();
  const parsed = ApplicationSchema.safeParse(body);
  if (!parsed.success) {
    const fieldLabels: Record<string, string> = {
      firstName:      'First Name',    lastName:  'Last Name',
      email:          'Email',         mobile:    'Phone Number',
      city:           'City',          country:   'Country',
      orgName:        'Organisation Name',
      orgType:        'Organisation Type',
      jobTitle:       'Job Title',
      useCase:        'Use Case',
      useDescription: 'Intended Use Description',
    };
    const msg = parsed.error.issues.map(i => {
      const field = i.path[0] ? String(i.path[0]) : '';
      const label = fieldLabels[field] || field;
      return label ? label + ': ' + i.message : i.message;
    }).join(' | ');
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  const data = parsed.data;

  const sanitised = {
    ...data,
    firstName:      sanitizeText(data.firstName),
    lastName:       sanitizeText(data.lastName),
    orgName:        sanitizeText(data.orgName),
    jobTitle:       sanitizeText(data.jobTitle),
    useDescription: sanitizeText(data.useDescription),
  };

  const refNumber = generateRefNumber();

  const application = await prisma.dataApplication.create({
    data: {
      firstName:      sanitised.firstName,
      lastName:       sanitised.lastName,
      email:          sanitised.email,
      mobile:         sanitised.mobile,
      city:           sanitised.city,
      country:        sanitised.country,
      orgName:        sanitised.orgName,
      orgType:        sanitised.orgType,
      jobTitle:       sanitised.jobTitle,
      website:        sanitised.website || null,
      planInterest:   sanitised.planInterest,
      useCase:        sanitised.useCase,
      useDescription: sanitised.useDescription,
      dataVolume:     sanitised.dataVolume || null,
      refNumber,
      status:         'PENDING',
    },
  });

  return NextResponse.json({
    success: true,
    refNumber: application.refNumber,
    message:   'Application received. Our team will review within 2-3 business days.',
  });
});

export const GET = withErrorHandling(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const plan   = searchParams.get('plan');
  const status = searchParams.get('status');

  const applications = await prisma.dataApplication.findMany({
    where: {
      ...(plan   ? { planInterest: plan as 'lite' | 'pro' | 'enterprise' } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ applications });
});
