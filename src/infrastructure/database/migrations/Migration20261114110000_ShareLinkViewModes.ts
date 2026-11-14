import { Migration } from '@mikro-orm/migrations'

export class Migration20261114110000_ShareLinkViewModes extends Migration {
	override up() {
		this.addSql('alter table `entry` add column `created_via` text null;')
		this.addSql('alter table `share_capability` add column `blank` integer null;')
	}

	override down() {
		this.addSql('alter table `share_capability` drop column `blank`;')
		this.addSql('alter table `entry` drop column `created_via`;')
	}
}
