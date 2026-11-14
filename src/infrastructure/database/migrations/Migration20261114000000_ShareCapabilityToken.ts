import { Migration } from '@mikro-orm/migrations'

export class Migration20261114000000_ShareCapabilityToken extends Migration {
	override up() {
		this.addSql('alter table `share_capability` add column `token` text null;')
	}

	override down() {
		this.addSql('alter table `share_capability` drop column `token`;')
	}
}
