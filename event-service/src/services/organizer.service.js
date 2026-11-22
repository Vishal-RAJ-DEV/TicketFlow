const { randomUUID } = require('crypto');
const prisma = require('../config/prisma');
const { BadRequestError, ForbiddenError, NotFoundError } = require('../utils/error');
const { requireString, optionalString, optionalUrl, slugify } = require('../utils/validation');

const MANAGEMENT_ROLES = ['OWNER', 'ADMIN'];
const EDIT_ROLES = ['OWNER', 'ADMIN', 'EDITOR'];

const getOrganizerRole = async (client, organizerId, userId) => {
  const organizer = await client.organizer.findUnique({
    where: { id: organizerId },
    select: {
      id: true,
      ownerId: true,
      status: true,
      members: {
        where: { userId },
        select: { role: true },
        take: 1,
      },
    },
  });

  if (!organizer) throw new NotFoundError('Organizer not found');
  if (organizer.status !== 'ACTIVE') throw new ForbiddenError('Organizer account is not active');

  if (organizer.ownerId === userId) return 'OWNER';
  return organizer.members[0]?.role || null;
};

const assertOrganizerAccess = async (client, organizerId, userId, allowedRoles = EDIT_ROLES) => {
  const role = await getOrganizerRole(client, organizerId, userId);
  if (!role || !allowedRoles.includes(role)) {
    throw new ForbiddenError('You do not have permission to manage this organizer');
  }
  return role;
};

const createOrganizer = async (userId, data) => {
  const name = requireString(data.name, 'name', 120);
  const id = randomUUID();
  const slug = slugify(data.slug || name) + '-' + id.slice(0, 8);
  const contactEmail = optionalString(data.contactEmail, 'contactEmail', 254);
  const websiteUrl = optionalUrl(data.websiteUrl, 'websiteUrl', 500);
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new BadRequestError('contactEmail must be a valid email address');
  }

  return prisma.organizer.create({
    data: {
      id,
      name,
      slug,
      description: optionalString(data.description, 'description', 2000),
      contactEmail,
      websiteUrl,
      ownerId: userId,
      members: {
        create: { userId, role: 'OWNER' },
      },
    },
    include: { members: true },
  });
};

const listOrganizers = async (userId) => prisma.organizer.findMany({
  where: {
    OR: [
      { ownerId: userId },
      { members: { some: { userId } } },
    ],
  },
  include: {
    _count: { select: { venues: true, events: true, members: true } },
  },
  orderBy: { createdAt: 'desc' },
});

const getOrganizer = async (organizerId, userId) => {
  await assertOrganizerAccess(prisma, organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return prisma.organizer.findUnique({
    where: { id: organizerId },
    include: { _count: { select: { venues: true, events: true, members: true } } },
  });
};

const updateOrganizer = async (organizerId, userId, data) => {
  await assertOrganizerAccess(prisma, organizerId, userId, MANAGEMENT_ROLES);
  const update = {};
  if (data.name !== undefined) update.name = requireString(data.name, 'name', 120);
  if (data.description !== undefined) update.description = optionalString(data.description, 'description', 2000);
  if (data.contactEmail !== undefined) {
    update.contactEmail = optionalString(data.contactEmail, 'contactEmail', 254);
    if (update.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.contactEmail)) {
      throw new BadRequestError('contactEmail must be a valid email address');
    }
  }
  if (data.websiteUrl !== undefined) update.websiteUrl = optionalUrl(data.websiteUrl, 'websiteUrl', 500);
  if (!Object.keys(update).length) throw new BadRequestError('No valid organizer fields were supplied');
  return prisma.organizer.update({ where: { id: organizerId }, data: update });
};

const listMembers = async (organizerId, userId) => {
  await assertOrganizerAccess(prisma, organizerId, userId, ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']);
  return prisma.organizerMember.findMany({
    where: { organizerId },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });
};

const upsertMember = async (organizerId, actorId, data) => {
  await assertOrganizerAccess(prisma, organizerId, actorId, MANAGEMENT_ROLES);
  const userId = requireString(data.userId, 'userId', 80);
  const role = data.role || 'VIEWER';
  if (!['ADMIN', 'EDITOR', 'VIEWER'].includes(role)) {
    throw new BadRequestError('role must be ADMIN, EDITOR, or VIEWER');
  }
  const organizer = await prisma.organizer.findUnique({ where: { id: organizerId }, select: { ownerId: true } });
  if (organizer.ownerId === userId) {
    throw new BadRequestError('The organizer owner role cannot be changed through member management');
  }
  return prisma.organizerMember.upsert({
    where: { organizerId_userId: { organizerId, userId } },
    create: { organizerId, userId, role },
    update: { role },
  });
};

const removeMember = async (organizerId, actorId, memberUserId) => {
  await assertOrganizerAccess(prisma, organizerId, actorId, MANAGEMENT_ROLES);
  const organizer = await prisma.organizer.findUnique({ where: { id: organizerId }, select: { ownerId: true } });
  if (organizer.ownerId === memberUserId) {
    throw new BadRequestError('The organizer owner cannot be removed');
  }
  const result = await prisma.organizerMember.deleteMany({
    where: { organizerId, userId: memberUserId },
  });
  if (!result.count) throw new NotFoundError('Organizer member not found');
  return { removed: true };
};

module.exports = {
  createOrganizer,
  listOrganizers,
  getOrganizer,
  updateOrganizer,
  listMembers,
  upsertMember,
  removeMember,
  getOrganizerRole,
  assertOrganizerAccess,
  MANAGEMENT_ROLES,
  EDIT_ROLES,
};