import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcryptjs';
import { Model } from 'mongoose';
import { CompanyApp } from './schemas/company-app.schema';
import { User } from './schemas/user.schema';

const defaultApps = [
  {
    name: 'Montao CRM',
    description: 'Gestion comercial, clientes, visitas, oportunidades y reportes de venta.',
    category: 'Ventas',
    group: 'Productividad',
    owner: 'Equipo Comercial',
    url: 'http://localhost:4200',
    status: 'Online',
    initials: 'CRM',
    icon: '▦',
    order: 1,
  },
  {
    name: 'Montao Rent',
    description: 'Contratos, vehiculos, mantenimientos, seguros y control de alquileres.',
    category: 'Operaciones',
    group: 'Operaciones',
    owner: 'Renta y Flota',
    url: 'http://localhost:4300',
    status: 'Revision',
    initials: 'MR',
    icon: '▣',
    order: 2,
  },
  {
    name: 'Montao GPS',
    description: 'Instalaciones, inventario, rutas, vehiculos y seguimiento tecnico.',
    category: 'Tecnologia',
    group: 'Operaciones',
    owner: 'Soporte GPS',
    url: 'http://localhost:8100',
    status: 'Online',
    initials: 'GPS',
    icon: '⌁',
    order: 3,
  },
  {
    name: 'Montao Metricas',
    description: 'Panel ejecutivo para indicadores, visitas, ventas y rendimiento por gestor.',
    category: 'Analitica',
    group: 'Finanzas y Analitica',
    owner: 'Direccion',
    url: 'http://localhost:8080',
    status: 'Online',
    initials: 'MT',
    icon: '▥',
    order: 4,
  },
  {
    name: 'Facturacion INCOSIS',
    description: 'Facturas, comprobantes, clientes, productos y resumen financiero.',
    category: 'Finanzas',
    group: 'Finanzas y Analitica',
    owner: 'Administracion',
    url: 'http://localhost:4400',
    status: 'Interna',
    initials: 'FI',
    icon: '▤',
    order: 5,
  },
  {
    name: 'Montao Talleres',
    description: 'Gestion de talleres, ordenes de trabajo, mecanicos y servicios tecnicos.',
    category: 'Operaciones',
    group: 'Operaciones',
    owner: 'Talleres',
    url: 'http://localhost:4500',
    status: 'Interna',
    initials: 'TL',
    icon: '⚙',
    order: 6,
  },
  {
    name: 'Montao Marketplace',
    description: 'Publicacion, busqueda y gestion comercial de vehiculos disponibles.',
    category: 'Ventas',
    group: 'Productividad',
    owner: 'Marketplace',
    url: 'http://localhost:4600',
    status: 'Revision',
    initials: 'MP',
    icon: '▧',
    order: 7,
  },
  {
    name: 'Montao Repuestos',
    description: 'Catalogo, inventario y despacho de repuestos para vehiculos y talleres.',
    category: 'Operaciones',
    group: 'Operaciones',
    owner: 'Repuestos',
    url: 'http://localhost:4700',
    status: 'Revision',
    initials: 'RP',
    icon: '▨',
    order: 8,
  },
  {
    name: 'Montao Dealers',
    description: 'Gestion de dealers, inventario aliado, solicitudes y relaciones comerciales.',
    category: 'Ventas',
    group: 'Productividad',
    owner: 'Dealers',
    url: 'http://localhost:4800',
    status: 'Revision',
    initials: 'DL',
    icon: '▩',
    order: 9,
  },
  {
    name: 'Montao Drive',
    description: 'Repositorio central para documentos, contratos, archivos y recursos internos.',
    category: 'Productividad',
    group: 'Productividad',
    owner: 'Drive',
    url: 'http://localhost:4900',
    status: 'Revision',
    initials: 'DR',
    icon: '▤',
    order: 10,
  },
] as const;

@Injectable()
export class StartupService implements OnModuleInit {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(CompanyApp.name) private readonly appModel: Model<CompanyApp>,
  ) {}

  async onModuleInit() {
    await this.prepareUsersCollection();
    await this.seedDatabase();
  }

  private async prepareUsersCollection() {
    await this.userModel.collection.dropIndex('username_1').catch(() => {});

    const legacyUsers = await this.userModel.collection
      .find({ email: { $exists: false } })
      .toArray();

    for (const legacyUser of legacyUsers) {
      const username = String(legacyUser['username'] || legacyUser._id).trim().toLowerCase();
      const email = username.includes('@') ? username : `${username}@montao.local`;
      await this.userModel.collection.updateOne({ _id: legacyUser._id }, { $set: { email } });
    }
  }

  private async seedDatabase() {
    const adminEmail = String(process.env['ADMIN_EMAIL'] || 'super_admin@montao.local')
      .trim()
      .toLowerCase();
    const adminPassword = process.env['ADMIN_PASSWORD'] || 'admin123';
    const admin = await this.userModel.findOne({ email: adminEmail });

    if (!admin) {
      await this.userModel.create({
        email: adminEmail,
        passwordHash: await bcrypt.hash(adminPassword, 12),
        name: 'Super Admin',
        role: 'admin',
      });
    }

    for (const app of defaultApps) {
      await this.appModel.updateOne(
        { name: app.name },
        { $setOnInsert: app },
        { upsert: true },
      );
    }

    await this.appModel.updateMany({ name: 'GPS Mobile' }, { $set: { name: 'Montao GPS' } });
  }
}
